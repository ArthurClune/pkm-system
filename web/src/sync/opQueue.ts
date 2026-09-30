// pattern: Imperative Shell
// Persistence completion and HTTP delivery are deliberately separate: a
// WriteTicket settles when the active storage accepts a write, while drain()
// reports whether every retained write reached the server.
//
// Every signal is a listener added after construction, and SyncProvider adds
// them in effects, after the commit that built the queue. No event can precede
// those subscriptions: every emission follows at least one await (persist runs
// on persistChain, delivery waits on a POST), and React runs a commit's
// passive effects in one synchronous flush. So no method here may emit
// synchronously.
import { ApiError } from "../api/client";
import type { BlockOp } from "../api/ops";
import type { OpsAck } from "../api/payloads";
import { apiPost } from "../api/typedClient";
import type { PendingBatch, Replica } from "../replica/client";
import { availabilityOf, isSessionFatal, ReplicaError,
         type ReplicaAvailability } from "../replica/errors";
import { newUid } from "../uid";
import { listeners } from "./listeners";
import { readOpsAck, type OpsAckReading } from "./opsAck";
import { append, clearMarks, createOutbox, forget, headPrecedes, laneHead,
         markFollows, settleHead, type LaneEntry } from "./outbox";
import { readPoisonMarkIntents,
         writePoisonMarkIntents } from "./poisonIntentStore";
import { withIntent, type PoisonEvent } from "./poisonIntents";
import { createQueueState, terminalReason, transitionQueue,
         type QueueEffect, type QueueEvent } from "./queueState";
import { isTerminalRejection } from "./rejection";

export const clientId = newUid();

export type WriteOutcome =
  | { status: "persisted"; pending: number }
  | { status: "failed"; error: unknown };

export type DeliveryOutcome =
  | { status: "delivered" }
  | { status: "failed"; error: unknown };

export interface WriteTicket {
  id: string;
  scope: readonly string[];
  settled: Promise<WriteOutcome>;
  /** Resolves only when this ticket's server POST is acknowledged or reaches
   * a terminal failure. Persistence settlement alone is not server causality. */
  delivered: Promise<DeliveryOutcome>;
}

export type { PoisonEvent };

export interface PoisonMarkFailure {
  event: PoisonEvent;
  error: unknown;
}

export type DrainOutcome =
  | { status: "drained" }
  | { status: "blocked"; reason: "offline" | "retryable" |
      "recovering" | "disposed"; pending: number; error?: unknown };

export interface OpQueue {
  enqueue(ops: BlockOp[], scope?: readonly string[]): WriteTicket;
  settled(): Promise<void>;
  drain(): Promise<DrainOutcome>;
  setOnline(online: boolean): void;
  pause(reason: "recovery"): void;
  resume(reason: "recovery"): void;
  dispose(): void;
  /** The replica refused an op on its merits, or the server terminally
   * rejected a lane entry: the active outline must be repaired from the
   * server. */
  onDesync(fn: (error: unknown) => void): () => void;
  /** Every drain run's outcome, however it was started. */
  onDrain(fn: (outcome: DrainOutcome) => void): () => void;
  /** Either delivery path's ack named a skipped op (see deliverLaneHead and
   * the durable batch loop in runDrain) -- the active view is stale and must
   * refetch. Never a desync: the batch committed, so nothing here is retried
   * or discarded. */
  onSkipped(fn: () => void): () => void;
  onPending(fn: (n: number) => void): () => void;
  /** Re-read the durable count and publish it through onPending. The ONLY way
   * for an outside caller to act on "the durable table may have changed
   * without this queue touching it" — a previous session's rows at mount, or a
   * write the offline shim enqueued inside the worker. A caller that reads the
   * replica itself and sets its own copy of the count silently disables the
   * re-emit suppression on that number (see emitPending). */
  refreshPending(): Promise<number>;
  /** Ops that exist ONLY in this tab's memory (the fallback lane) — never a
   * durable replica row, which survives a reload fine. This is the gate a
   * beforeunload guard must use: onPending also counts durable rows, and
   * gating on it would interrupt an ordinary offline reload that risks
   * nothing. */
  onUnsentInMemory(fn: (n: number) => void): () => void;
  /** Internal recovery ownership signal. Unlike onPoison, this fires before
   * the durable poison mark so a recovery lease cannot flush a stale row. */
  onPoisonPending(fn: () => void): () => void;
  onPoisonMarkFailed(fn: (failure: PoisonMarkFailure) => void): () => void;
  onPoison(fn: (event: PoisonEvent) => void): () => void;
  /** Fires once per markRetainedPoison call in which intents existed and NONE
   * matched a durable row — the ownership claim this signals has nothing left
   * to repair, unlike onPoison's per-matched-intent report. Never fires for a
   * round with no retained intents. */
  onPoisonMarkUnmatched(fn: () => void): () => void;
  /** Retained mark intents, including reload fallback metadata. */
  poisonMarkIntents(): readonly PoisonEvent[];
  /** Retry only durable poison marking. Never performs an ops POST. */
  retryPoisonMarks(): Promise<readonly PoisonEvent[]>;
  /** Drop retained mark intents without marking them. The escape
   * from a profile whose replica can never open: needs no replica call. If
   * the replica later opens, the unmarked batch redelivers, the server
   * rejects it again, and the normal poison → repair flow handles it then. */
  discardPoisonIntents(): void;
  /** Deliver every lane entry that a durable batch (named by its batch_id)
   * follows, in order, before that batch may itself be POSTed. This is how
   * the recovery flush (replicaSync.flushBatches) — which posts leased
   * durable rows on its own, knowing nothing about the lane — gets the same
   * ordering guarantee the drain enforces on itself: call it
   * before every batch that flush posts. A no-op when nothing in the lane
   * precedes `batchId`. Throws, and leaves the entry retained, on a POST
   * failure — a discard is the drain's decision alone, never this door's —
   * and throws if the queue is disposed. */
  deliverLaneAhead(batchId: string): Promise<void>;
}

let nextTicket = 1;

function ticket(scope: readonly string[] | undefined,
                settled: Promise<WriteOutcome>,
                delivered: Promise<DeliveryOutcome>): WriteTicket {
  return { id: `write-${nextTicket++}`, scope: scope ?? [], settled, delivered };
}

function postOps(ops: BlockOp[], batchId: string): Promise<OpsAck> {
  return apiPost("/api/ops", {
    body: { client_id: clientId, batch_id: batchId, ops },
  });
}

function createReplicaQueue(replica: Replica): OpQueue {
  let poisonMarkIntents = readPoisonMarkIntents();
  // Connectivity + retry policy lives in the queueState core; this shell owns
  // the timer handle and dispatches events into it.
  let qstate = createQueueState(poisonMarkIntents.length > 0);
  let pendingCount = 0;
  let persistChain = Promise.resolve();
  let drainRun: Promise<DrainOutcome> | null = null;
  let drainAgain = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const desync = listeners<unknown>();
  const drained = listeners<DrainOutcome>();
  const skipped = listeners<void>();
  const pending = listeners<number>();
  const unsentInMemory = listeners<number>();
  const poisonPending = listeners<void>();
  const poisonMarkFailed = listeners<PoisonMarkFailure>();
  const poison = listeners<PoisonEvent>();
  const poisonMarkUnmatched = listeners<void>();
  const deliveries = new Map<string, (outcome: DeliveryOutcome) => void>();
  // The in-memory lane: enqueues whose ops could not be persisted locally (a
  // full disk, OPFS access-handle contention, an exhausted SAH pool),
  // retained in FIFO order and delivered by drain() under the same
  // connectivity/retry/recovery policy as durable rows — never POSTed from
  // enqueue(). Its ordering against durable batches lives in the outbox core;
  // each entry's delivery resolver lives beside it, keyed by batch id.
  let outbox = createOutbox();
  const laneResolvers = new Map<string, (outcome: DeliveryOutcome) => void>();
  // Whether the replica can be used at all, DERIVED from this queue's own
  // failed RPCs and latched only on evidence that is itself permanent (the
  // worker's latched open, or a terminally failed RPC client — never a
  // timeout). The queue does not need telling by anyone: the single owner is
  // the worker, and this is a local cache of what it said. Nothing here lifts
  // the recovery barrier — that decision needs the stronger `unusable`
  // evidence and belongs to startup.
  let availability: ReplicaAvailability | null = null;
  const noteReplicaFailure = (error: unknown): void => {
    if (availability === null && isSessionFatal(error)) {
      availability = availabilityOf(error);
    }
  };

  /** Durable rows plus retained in-memory entries: what the UI must show as
   * "changes pending", and what a blocked drain reports. */
  const totalPending = (): number => pendingCount + outbox.entries.length;
  // Every lane mutation site (append, shift-on-delivery, shift-on-4xx)
  // already calls emitPending() immediately after, so this is the one choke
  // point that keeps onUnsentInMemory in step with the lane without a second
  // call site to forget. dispose() never touches the lane's length —
  // it settles entries in place, deliberately keeping them in the pending
  // diagnostic — so it needs no emit here either.
  // Each emission costs every subscriber a re-render, and in the app that is
  // one per mounted outline, so a count that did not move is not
  // published: a flushed edit used to publish `unsentInMemory: 0` on both its
  // persist and its delivery. null = nothing published yet, so a subscriber
  // registered before the first emit still learns the starting value.
  //
  // INVARIANT: every writer of pendingCount publishes through here, via
  // setPendingCount below, and no subscriber may write its own copy of the
  // count from any other source (refreshPending is the door for an outside
  // "re-read the durable table" — see SyncProvider). Suppressing a repeat is
  // only sound while this cache is what the subscribers actually hold: a
  // second writer moves them without moving `lastPending`, and every later
  // emit of that same number is then dropped as a no-op, leaving the count
  // stuck until it happens to change again.
  let lastPending: number | null = null;
  let lastUnsent: number | null = null;
  const emitPending = (): void => {
    const total = totalPending();
    const unsent = outbox.entries.length;
    if (total !== lastPending) {
      lastPending = total;
      pending.emit(total);
    }
    if (unsent !== lastUnsent) {
      lastUnsent = unsent;
      unsentInMemory.emit(unsent);
    }
  };

  /** The one way to move the durable count: assignment and publication in a
   * single step, so no path can leave the two apart (see emitPending). */
  const setPendingCount = (n: number): void => {
    pendingCount = n;
    emitPending();
  };

  /** Settle the lane entry `head` with `outcome`, shifting it out of the lane
   * only if it is still at the front (see settleHead: the drain and
   * deliverLaneAhead may race to settle the same head). Its resolver is
   * called at most once; a second settle finds none. */
  const settleLaneHead = (
    head: LaneEntry, outcome: DeliveryOutcome,
  ): void => {
    outbox = settleHead(outbox, head.batchId);
    const resolve = laneResolvers.get(head.batchId);
    laneResolvers.delete(head.batchId);
    resolve?.(outcome);
    emitPending();
  };

  /** Read a committed batch's ack — the one place the three delivery sites
   * (lane head, durable batch, deliverLaneAhead) do so. Skipped ops are not a
   * rejection: the batch committed, so nothing is retried or discarded. The
   * skipped list is consulted regardless of `availability`: a replica-backed
   * tab's own feed tombstones the replica row, but no resync event follows
   * from that alone, so the view keeps the ghost until something else bumps
   * resync. The extra refetch is harmless when the feed also converges the
   * row. */
  const noteCommitted = (ack: OpsAck): OpsAckReading => {
    const reading = readOpsAck(ack);
    if (reading.skipped.length > 0) {
      skipped.emit(undefined);
    }
    return reading;
  };

  const finishDelivery = (batchId: string, outcome: DeliveryOutcome): void => {
    const resolve = deliveries.get(batchId);
    if (!resolve) return;
    deliveries.delete(batchId);
    resolve(outcome);
  };

  const finishAllDeliveries = (outcome: DeliveryOutcome): void => {
    for (const resolve of deliveries.values()) resolve(outcome);
    deliveries.clear();
  };

  const runEffects = (effects: readonly QueueEffect[]): void => {
    for (const eff of effects) {
      if (eff.type === "clear-timer") {
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = null;
      } else if (eff.type === "start-timer") {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          dispatch({ type: "retry-fired" });
          void drain();
        }, eff.delayMs);
      } else {
        kick();
      }
    }
  };

  const dispatch = (event: QueueEvent) => {
    const transition = transitionQueue(qstate, event);
    qstate = transition.state;
    runEffects(transition.effects);
    return transition;
  };

  const countPending = async (): Promise<number> => {
    // A replica whose availability is already known must not be asked: skip
    // the RPC rather than rediscovering it on every call via a rejected
    // promise.
    if (availability !== null) return pendingCount;
    try {
      setPendingCount(await replica.pendingCount());
    } catch (error: unknown) {
      // The last observed count is still the best terminal diagnostic.
      noteReplicaFailure(error);
    }
    return pendingCount;
  };

  const blocked = async (
    reason: "offline" | "retryable" | "recovering" | "disposed",
    error?: unknown,
  ): Promise<DrainOutcome> => {
    await countPending();
    return {
      status: "blocked",
      reason,
      pending: totalPending(),
      ...(error === undefined ? {} : { error }),
    };
  };

  const failed = async (error: unknown): Promise<DrainOutcome> => {
    await countPending();
    const transition = dispatch({ type: "delivery-failed" });
    return {
      status: "blocked", reason: transition.blockedReason!,
      pending: totalPending(), error,
    };
  };

  /** Retain the mark intent so a reload, or an RPC failure right after this
   * call, still marks it. A mark RPC that throws leaves the row deliverable,
   * so an outside resume can hand the same batch out for a second rejection
   * — harmless here, since the only other effect a rejection drives, removing
   * the batch's `follows` mark, is an idempotent Map delete rather than the
   * decrement it used to be. */
  const rememberPoisonMark = (event: PoisonEvent): void => {
    poisonMarkIntents = withIntent(poisonMarkIntents, event);
    writePoisonMarkIntents(poisonMarkIntents);
  };

  const markRetainedPoison = async (): Promise<readonly PoisonEvent[]> => {
    if (qstate.disposed) throw new Error("op queue disposed");
    const intents = [...poisonMarkIntents];
    if (intents.length === 0) return [];
    dispatch({ type: "pause" });
    let result: { pending: number; matched: boolean } | null = null;
    const matchedIntents: PoisonEvent[] = [];
    for (const event of intents) {
      try {
        result = await replica.markPoisoned(event.rowId, JSON.stringify({
          status: event.status, message: event.message,
        }), event.batchId);
        if (result.matched) matchedIntents.push(event);
      } catch (error: unknown) {
        // Same fact, learned from a different call. An unmarkable intent still
        // holds the gate: knowing the replica is gone does not make delivering
        // past a KNOWN-rejected batch safe.
        noteReplicaFailure(error);
        poisonMarkFailed.emit({ event, error });
        throw error;
      }
    }
    if (result !== null) setPendingCount(result.pending);
    // The database is now the durable source of truth. Removing fallback
    // metadata before publication is crash-safe: startup discovers the
    // poisoned database rows. If removal fails, marking is idempotent.
    writePoisonMarkIntents([]);
    poisonMarkIntents = [];
    matchedIntents.forEach((event) => poison.emit(event));
    if (intents.length > 0 && matchedIntents.length === 0) {
      poisonMarkUnmatched.emit(undefined);
    }
    return matchedIntents;
  };

  /** Deliver the retained head — the drain's own caller has already checked
   * headPrecedes, so this only posts and settles. Returns the outcome the
   * drain must report, or null to keep looping. */
  const deliverLaneHead = async (
    head: LaneEntry,
  ): Promise<DrainOutcome | null> => {
    let ack: OpsAck;
    try {
      ack = await postOps(head.ops, head.batchId);
    } catch (error: unknown) {
      if (isTerminalRejection(error)) {
        // A lane entry has no durable row to poison, so terminal means
        // discarded: drop exactly the rejected entry — the only discard
        // this queue makes on its own — hold later entries behind the
        // recovery barrier, and let the onDesync listener run the
        // authoritative repair that resumes it.
        dispatch({ type: "pause" });
        settleLaneHead(head, { status: "failed", error });
        desync.emit(error);
        return blocked("recovering", error);
      }
      return failed(error);
    }
    noteCommitted(ack);
    settleLaneHead(head, { status: "delivered" });
    dispatch({ type: "batch-succeeded" });
    const laneBlock = terminalReason(qstate);
    if (laneBlock !== null) return blocked(laneBlock);
    return null;
  };

  /** The server rejected a durable batch outright. Terminal for that batch:
   * it is poisoned rather than retried, and the recovery barrier holds until
   * an outside repair lifts it. */
  const rejectDurableBatch = async (
    batch: PendingBatch, error: ApiError,
  ): Promise<DrainOutcome> => {
    const event: PoisonEvent = {
      rowId: batch.id,
      batchId: batch.batch_id,
      ops: batch.ops,
      status: error.status,
      message: error.message,
    };
    // Claim the shared recovery barrier as soon as the server rejects
    // the batch. markPoisoned may wait behind a recovery lease whose
    // snapshot still says this row is valid; that lease must learn it
    // is stale before it begins its next POST.
    dispatch({ type: "pause" });
    poisonPending.emit(undefined);
    rememberPoisonMark(event);
    finishDelivery(batch.batch_id, { status: "failed", error });
    // Terminal for this batch: it is never POSTed again (the barrier holds
    // until the repair, and marking is retried, never delivery), so its
    // `follows` mark — if it had one at all — is removed here rather than
    // waiting for a deleteBatch that will never arrive.
    outbox = forget(outbox, batch.batch_id);
    try {
      await markRetainedPoison();
    } catch (rpcError: unknown) {
      return failed(rpcError);
    }
    return blocked("recovering");
  };

  const runDrain = async (): Promise<DrainOutcome> => {
    await settleAll();
    const initialBlock = terminalReason(qstate);
    if (initialBlock !== null) return blocked(initialBlock);

    /** The durable queue is unreachable in this session, so nothing durable
     * can be delivered and nothing durable can still stand ahead of a
     * retained entry FOR THIS SESSION. Returns the outcome to report, or
     * null to keep looping (there is lane work, or a kick landed mid-drain).
     *
     * This does not hold across sessions: a later session with a working
     * replica replays the deferred durable rows, and by then they are
     * strictly behind the lane ops this session already delivered. That
     * ordering is defensible rather than merely accepted, because both
     * choke points stamp the guards: base_text_hash on update_text and
     * base_subtree_hash on delete. The durable row's hash was taken against
     * a tree that is now stale, so the server lands its texts under a
     * daily-note `[[conflict]]` header instead of silently overwriting or
     * deleting the newer lane op's work.
     *
     * pendingCount is deliberately NOT zeroed: durable rows persisted before
     * the replica died are genuinely undelivered and belong in the pending
     * diagnostic. Outstanding delivery promises are deliberately left
     * unsettled, exactly as they are today — dispose() is what settles them —
     * because resolving them "delivered" would be a lie and resolving them
     * "failed" would change what the outline session's replay does. */
    const deferDurableQueue = (): DrainOutcome | null => {
      if (outbox.entries.length > 0) return null;
      if (drainAgain) return null;
      return { status: "drained" };
    };

    for (;;) {
      drainAgain = false;
      if (availability !== null) {
        const head = laneHead(outbox);
        if (head !== undefined) {
          const outcome = await deliverLaneHead(head);
          if (outcome !== null) return outcome;
          continue;
        }
        const outcome = deferDurableQueue();
        if (outcome !== null) return outcome;
        continue;
      }
      let batch;
      try {
        batch = await replica.nextBatch();
      } catch (error: unknown) {
        noteReplicaFailure(error);
        if (availability === null) return failed(error);
        const outcome = deferDurableQueue();
        if (outcome !== null) return outcome;
        continue;
      }
      // The lane now needs this read before it can go out — a batch persisted
      // after the head is what used to let it overtake — so a
      // transient nextBatch() failure (caught above) delays the lane through
      // the normal backoff rather than losing it.
      if (headPrecedes(outbox, batch?.batch_id ?? null)) {
        const outcome = await deliverLaneHead(laneHead(outbox)!);
        if (outcome !== null) return outcome;
        continue;
      }
      if (batch === null) {
        finishAllDeliveries({ status: "delivered" });
        // Nothing durable is left, so no mark this queue holds can still be
        // waiting on a real predecessor: a batch flushed out-of-band (a
        // recovery lease, a rebase settle) never reaches deleteBatch or
        // rejectDurableBatch here to remove its own mark, and a stale one left
        // behind would hold the lane waiting on a batch_id that will never
        // return.
        outbox = clearMarks(outbox);
        // Published, not just assigned: an empty durable queue is exactly the
        // case where a stale over-count is cleared, and a banner still showing
        // the old number is the visible half of that.
        setPendingCount(0);
        if (outbox.entries.length > 0) continue;
        if (drainAgain) continue;
        return { status: "drained" };
      }
      let ack: OpsAck;
      try {
        ack = await postOps(batch.ops, batch.batch_id);
      } catch (error: unknown) {
        if (isTerminalRejection(error)) {
          return rejectDurableBatch(batch, error);
        }
        return failed(error);
      }
      const reading = noteCommitted(ack);
      let result;
      try {
        // The ack's seq lets a pull that snapshotted this batch as pending
        // accept a window that already carries it, instead of refetching
        // (the save's WS nudge and this ack race).
        result = await replica.deleteBatch(batch.id, batch.batch_id, reading.seq);
      } catch (error: unknown) {
        noteReplicaFailure(error);
        return failed(error);
      }
      finishDelivery(batch.batch_id, { status: "delivered" });
      // This batch is delivered, so its mark (if it had one — see outbox.ts)
      // no longer needs to hold any lane head behind it.
      outbox = forget(outbox, batch.batch_id);
      if (result.pending === 0) {
        // A durable row can be deleted outside this drain (a recovery flush
        // or a rebase settle): its ticket never gets a matching finishDelivery
        // call here, so it stays in `deliveries` unresolved. Once the durable
        // queue is observed empty, every remaining ticket must have been
        // delivered by one of those out-of-band paths — settle them now.
        finishAllDeliveries({ status: "delivered" });
      }
      setPendingCount(result.pending);
      dispatch({ type: "batch-succeeded" });
      const loopBlock = terminalReason(qstate);
      if (loopBlock !== null) return blocked(loopBlock);
    }
  };

  const drain = (): Promise<DrainOutcome> => {
    if (drainRun) {
      drainAgain = true;
      return drainRun;
    }
    drainRun = runDrain()
      .catch(failed)
      .then((outcome) => {
        drained.emit(outcome);
        // A kick() landing after runDrain's own final drainAgain check
        // (which loops once more only while the queue still looks empty)
        // but before drainRun is cleared below would otherwise be dropped
        // silently: kick() only records it by setting drainAgain when
        // drainRun is still set, and nothing else re-checks that flag once
        // runDrain has returned. Re-check it here: this is the only place
        // that can still see a kick landing in that window.
        //
        // A blocked outcome is not automatically dead: the very event that
        // kicked may be what lifted the block (setOnline(true) racing a drain
        // concluding offline, resume() racing one concluding recovering), and
        // dropping the kick then leaves delivery waiting for whatever kicks
        // the queue next — the user's next edit, or another reconnect.
        // So redrain only once the queue is no longer terminally
        // blocked: a still-offline queue would just repeat the same block, and
        // a retryable outcome already owns an armed timer that must keep its
        // backoff rather than being pre-empted by an immediate retry.
        // Late callers sharing this promise still observe the blocked outcome
        // that was true when it settled, not the redrain's.
        const missedKick = drainAgain && (outcome.status === "drained"
          || (terminalReason(qstate) === null && !qstate.retryScheduled));
        drainAgain = false;
        drainRun = null;
        if (missedKick) kick();
        return outcome;
      });
    return drainRun;
  };

  const kick = (): void => {
    if (drainRun) {
      drainAgain = true;
      return;
    }
    void drain();
  };

  const settleAll = async (): Promise<void> => {
    for (;;) {
      const tail = persistChain;
      await tail;
      if (tail === persistChain) return;
    }
  };

  return {
    enqueue(ops, scope) {
      if (ops.length === 0) {
        return ticket(scope, Promise.resolve({
          status: "persisted", pending: pendingCount,
        }), Promise.resolve({ status: "delivered" }));
      }
      let resolve!: (outcome: WriteOutcome) => void;
      const outcome = new Promise<WriteOutcome>((done) => { resolve = done; });
      let resolveDelivery!: (outcome: DeliveryOutcome) => void;
      const delivered = new Promise<DeliveryOutcome>((done) => {
        resolveDelivery = done;
      });
      const persist = async (): Promise<void> => {
        if (qstate.disposed) {
          const error = new Error("op queue disposed");
          resolve({ status: "failed", error });
          resolveDelivery({ status: "failed", error });
          return;
        }
        // Minted BEFORE the RPC so a lost reply cannot split the batch's
        // identity: if the worker persisted the row but the reply never
        // arrived (iOS suspending a PWA mid-RPC), the lane copy retained in
        // the catch below still carries the row's id, and whichever copy
        // delivers second lands on the server's applied_batches replay
        // instead of a create-collision 400.
        const batchId = newUid();
        try {
          const result = await replica.enqueue(ops, batchId);
          // Persisted durably: marked behind every lane entry appended
          // before it, if any (see markFollows).
          outbox = markFollows(outbox, batchId);
          if (qstate.disposed) {
            resolveDelivery({
              status: "failed", error: new Error("op queue disposed"),
            });
          } else {
            deliveries.set(batchId, resolveDelivery);
          }
          setPendingCount(result.pending);
          resolve({ status: "persisted", pending: pendingCount });
          if (!qstate.disposed) kick();
        } catch (error: unknown) {
          resolve({ status: "failed", error });
          const replicaError = error instanceof ReplicaError ? error : null;
          // The replica refused the OP, not the storing of it (unsupported
          // title syntax): the server would refuse it too, so retaining and
          // retrying can never help. The ONE case that still desyncs.
          if (replicaError?.rejected === true) {
            resolveDelivery({ status: "failed", error });
            desync.emit(error);
            return;
          }
          // Everything else means "could not persist locally right now", which
          // is NEVER a server rejection: the replica is a cache, not the
          // durability boundary. Firing onDesync would be the wrong answer,
          // because its authoritative repair would wipe the active outline to
          // the (edit-less) server state and detach the editor mid-keystroke.
          // So the ops are retained for ordered delivery by drain().
          //
          // Never classify by matching error MESSAGE text: any unlisted shape
          // — a wasm init failure, OPFS unavailable in private browsing, a
          // dead worker's RpcLifecycleError — must still be retained rather
          // than lost, and must not rebase the outline. The one-item
          // blocklist above (`rejected === true`) is the only case allowed
          // to bypass that.
          //
          // A `quota` flag was also emitted here, to drive an offline
          // read-only mode. Nothing could ever set it — the opfs-sahpool VFS
          // reports an exhausted disk as a bare SQLITE_IOERR — so
          // storage exhaustion arrives, correctly, as one more "could not
          // persist locally right now" and is retained like the rest.
          noteReplicaFailure(error);
          if (qstate.disposed) {
            resolveDelivery({
              status: "failed", error: new Error("op queue disposed"),
            });
            return;
          }
          // Retain the ops in an ordered in-memory lane and let drain()
          // deliver them: that keeps offline state, backoff and the
          // recovery barrier in force, and keeps these ops behind the
          // durable batches that preceded them — by construction,
          // not by count (see append).
          outbox = append(outbox, batchId, ops);
          laneResolvers.set(batchId, resolveDelivery);
          emitPending();
          kick();
        }
      };
      persistChain = persistChain.then(persist, persist);
      return ticket(scope, outcome, delivered);
    },
    settled: settleAll,
    drain,
    setOnline(next) {
      dispatch({ type: "set-online", online: next });
    },
    pause() {
      dispatch({ type: "pause" });
    },
    resume() {
      dispatch({ type: "resume" });
    },
    dispose() {
      if (qstate.disposed) return;
      dispatch({ type: "dispose" });
      const error = new Error("op queue disposed");
      finishAllDeliveries({ status: "failed", error });
      // Settle every retained entry, but keep the lane populated: exactly like
      // the durable row a disposed queue still reports, these ops belong in the
      // terminal pending diagnostic. No new drain can start (runDrain
      // short-circuits on terminalReason), and if a POST already in flight
      // succeeds its settle finds no resolver left, so the entry stays failed.
      for (const resolve of laneResolvers.values()) {
        resolve({ status: "failed", error });
      }
      laneResolvers.clear();
    },
    onDesync: desync.add,
    onDrain: drained.add,
    onSkipped: skipped.add,
    onPending: pending.add,
    async refreshPending() {
      await countPending();
      return totalPending();
    },
    onUnsentInMemory: unsentInMemory.add,
    onPoisonPending: poisonPending.add,
    onPoisonMarkFailed: poisonMarkFailed.add,
    onPoison: poison.add,
    onPoisonMarkUnmatched: poisonMarkUnmatched.add,
    poisonMarkIntents: () => [...poisonMarkIntents],
    retryPoisonMarks: markRetainedPoison,
    discardPoisonIntents: () => {
      poisonMarkIntents = [];
      writePoisonMarkIntents(poisonMarkIntents);
    },
    async deliverLaneAhead(batchId) {
      if (qstate.disposed) throw new Error("op queue disposed");
      while (headPrecedes(outbox, batchId)) {
        const head = laneHead(outbox)!;
        // Left retained on any error — a discard is the drain's decision
        // alone, and this door never makes it.
        const ack = await postOps(head.ops, head.batchId);
        noteCommitted(ack);
        settleLaneHead(head, { status: "delivered" });
      }
    },
  };
}

export function createOpQueue(replica: Replica): OpQueue {
  return createReplicaQueue(replica);
}
