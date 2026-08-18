// pattern: Imperative Shell
// Persistence completion and HTTP delivery are deliberately separate: a
// WriteTicket settles when the active storage accepts a write, while drain()
// reports whether every retained write reached the server.
import { ApiError } from "../api/client";
import { apiPost } from "../api/typedClient";
import type { BlockOp } from "../api/ops";
import type { PendingBatch, PoisonedBatch, Replica } from "../replica/client";
import { availabilityOf, isSessionFatal, ReplicaError,
         type ReplicaAvailability } from "../replica/errors";
import { newUid } from "../uid";
import { createQueueState, terminalReason, transitionQueue,
         type QueueEffect, type QueueEvent } from "./queueState";

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

export interface PoisonEvent extends PoisonedBatch {}

export interface PoisonMarkFailure {
  event: PoisonEvent;
  error: unknown;
}

const POISON_MARK_INTENTS_KEY = "pkm.poison-mark-intents.v1";

const validPoisonEvent = (value: unknown): value is PoisonEvent => {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<PoisonEvent>;
  return Number.isInteger(event.rowId) && typeof event.batchId === "string" &&
    Array.isArray(event.ops) && typeof event.status === "number" &&
    typeof event.message === "string";
};

const readPoisonMarkIntents = (): PoisonEvent[] => {
  try {
    const raw = globalThis.localStorage?.getItem(POISON_MARK_INTENTS_KEY);
    if (raw === null || raw === undefined) return [];
    const parsed = JSON.parse(raw) as { version?: unknown; intents?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.intents)) return [];
    const unique = new Map<string, PoisonEvent>();
    for (const value of parsed.intents) {
      if (!validPoisonEvent(value)) continue;
      unique.set(`${value.rowId}\u0000${value.batchId}`, value);
    }
    return [...unique.values()].sort((a, b) =>
      a.rowId - b.rowId || a.batchId.localeCompare(b.batchId));
  } catch {
    // localStorage can be unavailable or contain data from a damaged write.
    return [];
  }
};

const writePoisonMarkIntents = (intents: readonly PoisonEvent[]): void => {
  try {
    if (intents.length === 0) {
      globalThis.localStorage?.removeItem(POISON_MARK_INTENTS_KEY);
    } else {
      globalThis.localStorage?.setItem(POISON_MARK_INTENTS_KEY, JSON.stringify({
        version: 1, intents,
      }));
    }
  } catch {
    // The in-memory barrier still protects this page. A stale durable intent
    // is safe: startup retries marking idempotently before delivery.
  }
};

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
  onPending(fn: (n: number) => void): () => void;
  /** Ops that exist ONLY in this tab's memory (the fallback lane) — never a
   * durable replica row, which survives a reload fine. This is the gate a
   * beforeunload guard must use: onPending also counts durable rows, and
   * gating on it would interrupt an ordinary offline reload that risks
   * nothing (pkm-0htf). */
  onUnsentInMemory(fn: (n: number) => void): () => void;
  /** Internal recovery ownership signal. Unlike onPoison, this fires before
   * the durable poison mark so a recovery lease cannot flush a stale row. */
  onPoisonPending(fn: () => void): () => void;
  onPoisonMarkFailed(fn: (failure: PoisonMarkFailure) => void): () => void;
  onPoison(fn: (event: PoisonEvent) => void): () => void;
  /** Retained mark intents, including reload fallback metadata. */
  poisonMarkIntents(): readonly PoisonEvent[];
  /** Retry only durable poison marking. Never performs an ops POST. */
  retryPoisonMarks(): Promise<readonly PoisonEvent[]>;
}

type Listener<T> = (value: T) => void;

function listeners<T>() {
  const set = new Set<Listener<T>>();
  return {
    add(fn: Listener<T>): () => void {
      set.add(fn);
      return () => { set.delete(fn); };
    },
    emit(value: T): void {
      set.forEach((fn) => {
        try { fn(value); } catch { /* listener isolation */ }
      });
    },
  };
}

let nextTicket = 1;

function ticket(scope: readonly string[] | undefined,
                settled: Promise<WriteOutcome>,
                delivered: Promise<DeliveryOutcome>): WriteTicket {
  return { id: `write-${nextTicket++}`, scope: scope ?? [], settled, delivered };
}

function postOps(ops: BlockOp[], batchId: string): Promise<unknown> {
  return apiPost("/api/ops", {
    body: { client_id: clientId, batch_id: batchId, ops },
  });
}

/** An enqueue whose ops could not be persisted locally (a full disk, OPFS
 * access-handle contention, an exhausted SAH pool). Retained in FIFO order and
 * delivered by drain() under the same connectivity/retry/recovery policy as
 * durable rows — never POSTed from enqueue() (pkm-49eh). */
interface FallbackEntry {
  /** Minted once, at append time: a retry must re-POST a byte-identical
   * payload under the same id, since the server binds batch_id to a
   * sha256 of the ops. */
  batchId: string;
  ops: BlockOp[];
  /** Durable batches persisted BEFORE this entry that must be delivered
   * first; decremented as they drain, and cleared once the durable queue is
   * observed empty. */
  durableAhead: number;
  resolve(outcome: DeliveryOutcome): void;
}

function createReplicaQueue(replica: Replica,
                            onDesync: (error: unknown) => void,
                            onDrain: (outcome: DrainOutcome) => void): OpQueue {
  let poisonMarkIntents = readPoisonMarkIntents();
  // Connectivity + retry policy lives in the queueState core; this shell owns
  // the timer handle and dispatches events into it.
  let qstate = createQueueState(poisonMarkIntents.length > 0);
  let pendingCount = 0;
  let persistChain = Promise.resolve();
  let drainRun: Promise<DrainOutcome> | null = null;
  let drainAgain = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = listeners<number>();
  const unsentInMemory = listeners<number>();
  const poisonPending = listeners<void>();
  const poisonMarkFailed = listeners<PoisonMarkFailure>();
  const poison = listeners<PoisonEvent>();
  const deliveries = new Map<string, (outcome: DeliveryOutcome) => void>();
  const fallback: FallbackEntry[] = [];
  // Durable batches persisted since the last fallback entry was appended:
  // they sit BEHIND that entry and must not overtake it.
  let durableSinceFallback = 0;
  // The availability fact, DERIVED from this queue's own failed RPCs and
  // latched only on evidence that is itself permanent (the worker's latched
  // open, or a terminally failed RPC client — never a timeout). The queue does
  // not need telling by anyone: the single owner is the worker, and this is a
  // local cache of what it said. Nothing here lifts the recovery barrier —
  // that decision needs the stronger `unusable` evidence and belongs to
  // startup (pkm-bjae).
  let unavailable: ReplicaAvailability | null = null;
  const noteReplicaFailure = (error: unknown): void => {
    if (unavailable === null && isSessionFatal(error)) {
      unavailable = availabilityOf(error);
    }
  };

  /** Durable rows plus retained in-memory entries: what the UI must show as
   * "changes pending", and what a blocked drain reports. */
  const totalPending = (): number => pendingCount + fallback.length;
  // Every fallback mutation site (append, shift-on-delivery, shift-on-4xx)
  // already calls emitPending() immediately after, so this is the one choke
  // point that keeps onUnsentInMemory in step with the lane without a second
  // call site to forget (pkm-0htf). dispose() never touches fallback.length —
  // it settles entries in place, deliberately keeping them in the pending
  // diagnostic — so it needs no emit here either.
  const emitPending = (): void => {
    pending.emit(totalPending());
    unsentInMemory.emit(fallback.length);
  };

  /** A durable batch reached a terminal state — delivered, or poisoned and so
   * never deliverable — so it no longer stands ahead of the retained head.
   * Poisoning must count too: the recovery coordinator deletes the poisoned row
   * outside the queue, so no deleteBatch ever arrives for it, and a head left
   * waiting on it would be overtaken by the next batch enqueued after it.
   * Only reached while that head still has batches ahead of it, since the lane
   * branch posts a head whose durableAhead is 0 before any batch is pulled. */
  const durableBatchSettled = (): void => {
    if (fallback.length > 0) {
      fallback[0].durableAhead = Math.max(0, fallback[0].durableAhead - 1);
    }
  };

  /** Zero the durable-precedence bookkeeping: no retained entry is left
   * waiting on a durable predecessor, and no entry appended next inherits one.
   * Each call site owns the argument for why that is true there. */
  const clearDurablePrecedence = (): void => {
    for (const entry of fallback) entry.durableAhead = 0;
    durableSinceFallback = 0;
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
    // Nothing to ask, and asking is what pkm-9x6u is about.
    if (unavailable !== null) return pendingCount;
    try {
      pendingCount = await replica.pendingCount();
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

  /** Returns true only for a genuinely new intent. A mark RPC that throws
   * leaves the row deliverable, so an outside resume can hand the same batch
   * out for a second rejection; the retained intent is what keeps the effects
   * that must happen once per batch — notably the lane decrement — idempotent
   * across those repeats. */
  const rememberPoisonMark = (event: PoisonEvent): boolean => {
    const key = `${event.rowId}\u0000${event.batchId}`;
    const retained = new Map(poisonMarkIntents.map((intent) =>
      [`${intent.rowId}\u0000${intent.batchId}`, intent]));
    const isNew = !retained.has(key);
    retained.set(key, event);
    poisonMarkIntents = [...retained.values()].sort((a, b) =>
      a.rowId - b.rowId || a.batchId.localeCompare(b.batchId));
    writePoisonMarkIntents(poisonMarkIntents);
    return isNew;
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
        // past a KNOWN-rejected batch safe (pkm-tu5k).
        noteReplicaFailure(error);
        poisonMarkFailed.emit({ event, error });
        throw error;
      }
    }
    if (result !== null) {
      pendingCount = result.pending;
      emitPending();
    }
    // The database is now the durable source of truth. Removing fallback
    // metadata before publication is crash-safe: startup discovers the
    // poisoned database rows. If removal fails, marking is idempotent.
    writePoisonMarkIntents([]);
    poisonMarkIntents = [];
    matchedIntents.forEach((event) => poison.emit(event));
    return matchedIntents;
  };

  /** Deliver the retained head, which has no durable batch left ahead of it.
   * Returns the outcome the drain must report, or null to keep looping. */
  const deliverLaneHead = async (
    head: FallbackEntry,
  ): Promise<DrainOutcome | null> => {
    try {
      await postOps(head.ops, head.batchId);
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status >= 400
          && error.status < 500) {
        // No durable row exists to poison, so this mirrors the legacy
        // queue's terminal 4xx: discard exactly the rejected entry — the
        // only discard this queue makes on its own — hold later entries
        // behind the recovery barrier, and let onDesync run the
        // authoritative repair that resumes it.
        dispatch({ type: "pause" });
        fallback.shift();
        head.resolve({ status: "failed", error });
        emitPending();
        try { onDesync(error); } catch { /* listener isolation */ }
        return blocked("recovering", error);
      }
      return failed(error);
    }
    fallback.shift();
    head.resolve({ status: "delivered" });
    emitPending();
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
    const firstRejection = rememberPoisonMark(event);
    finishDelivery(batch.batch_id, { status: "failed", error });
    // Terminal for this batch: it is never POSTed again (the barrier
    // holds until the repair, and marking is retried, never delivery), so
    // it stops standing ahead of a retained entry from here. Keyed to a
    // new mark intent so it counts once per batch: markPoisoned below can
    // throw, and the still-unmarked row is then handed out again by an
    // outside resume, taking the same 4xx. A second decrement would put
    // the head's count below the batches actually ahead of it and let the
    // retained op overtake one of them (pkm-yavj).
    if (firstRejection) durableBatchSettled();
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
     * ordering is defensible rather than merely accepted, because
     * base_text_hash is now stamped on update_text ops at both choke points —
     * the durable row's hash was taken against text that is now stale, so the
     * server forks a `[[conflict]]` sibling instead of silently
     * LWW-overwriting the newer lane op.
     *
     * pendingCount is deliberately NOT zeroed: durable rows persisted before
     * the replica died are genuinely undelivered and belong in the pending
     * diagnostic. Outstanding delivery promises are deliberately left
     * unsettled, exactly as they are today — dispose() is what settles them —
     * because resolving them "delivered" would be a lie and resolving them
     * "failed" would change what the outline session's replay does. */
    const deferDurableQueue = (): DrainOutcome | null => {
      clearDurablePrecedence();
      if (fallback.length > 0) return null;
      if (drainAgain) return null;
      return { status: "drained" };
    };

    for (;;) {
      drainAgain = false;
      const head = fallback[0];
      if (head !== undefined && head.durableAhead === 0) {
        const outcome = await deliverLaneHead(head);
        if (outcome !== null) return outcome;
        continue;
      }
      if (unavailable !== null) {
        const outcome = deferDurableQueue();
        if (outcome !== null) return outcome;
        continue;
      }
      let batch;
      try {
        batch = await replica.nextBatch();
      } catch (error: unknown) {
        noteReplicaFailure(error);
        if (unavailable === null) return failed(error);
        const outcome = deferDurableQueue();
        if (outcome !== null) return outcome;
        continue;
      }
      if (batch === null) {
        pendingCount = 0;
        finishAllDeliveries({ status: "delivered" });
        // Nothing durable is left, so nothing can still be ahead of a
        // retained entry: clear counts a stale read (or a queue flushed by a
        // rebase) left behind rather than waiting on a predecessor that will
        // never arrive. durableSinceFallback counts batches that are equally
        // gone, so it must be cleared too or the next appended entry inherits
        // a phantom predecessor.
        clearDurablePrecedence();
        if (fallback.length > 0) continue;
        if (drainAgain) continue;
        return { status: "drained" };
      }
      try {
        await postOps(batch.ops, batch.batch_id);
      } catch (error: unknown) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return rejectDurableBatch(batch, error);
        }
        return failed(error);
      }
      let result;
      try {
        result = await replica.deleteBatch(batch.id);
      } catch (error: unknown) {
        noteReplicaFailure(error);
        return failed(error);
      }
      pendingCount = result.pending;
      finishDelivery(batch.batch_id, { status: "delivered" });
      durableBatchSettled();
      if (pendingCount === 0) {
        // A durable row can be deleted outside this drain (a recovery flush
        // or a rebase settle): its ticket never gets a matching finishDelivery
        // call here, so it stays in `deliveries` unresolved. Once the durable
        // queue is observed empty, every remaining ticket must have been
        // delivered by one of those out-of-band paths — settle them now.
        finishAllDeliveries({ status: "delivered" });
      }
      emitPending();
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
        try { onDrain(outcome); } catch { /* observer isolation */ }
        // A kick() landing after runDrain's own final drainAgain check
        // (which loops once more only while the queue still looks empty)
        // but before drainRun is cleared below would otherwise be dropped
        // silently: kick() only records it by setting drainAgain when
        // drainRun is still set, and nothing else re-checks that flag once
        // runDrain has returned. Re-check it here, mirroring the legacy
        // queue's missedKick handling.
        //
        // A blocked outcome is not automatically dead: the very event that
        // kicked may be what lifted the block (setOnline(true) racing a drain
        // concluding offline, resume() racing one concluding recovering), and
        // dropping the kick then leaves delivery waiting for whatever kicks
        // the queue next — the user's next edit, or another reconnect
        // (pkm-v5x5). So redrain only once the queue is no longer terminally
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
        // instead of a create-collision 400 (pkm-ybgt).
        const batchId = newUid();
        try {
          const result = await replica.enqueue(ops, batchId);
          pendingCount = result.pending;
          if (fallback.length > 0) durableSinceFallback += 1;
          if (qstate.disposed) {
            resolveDelivery({
              status: "failed", error: new Error("op queue disposed"),
            });
          } else {
            deliveries.set(batchId, resolveDelivery);
          }
          emitPending();
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
            try { onDesync(error); } catch { /* listener isolation */ }
            return;
          }
          // Everything else means "could not persist locally right now", which
          // is NEVER a server rejection: the replica is a cache, not the
          // durability boundary. Firing onDesync would be the wrong answer,
          // because its authoritative repair would wipe the active outline to
          // the (edit-less) server state and detach the editor mid-keystroke.
          // So the ops are retained for ordered delivery by drain().
          //
          // This used to be an allowlist of three error shapes, two of them
          // matched by MESSAGE (quota / OPFS access-handle contention, pkm-c9hp
          // / exhausted SAH pool, pkm-ndcu). Whether the user's writes survived
          // therefore depended on string matching, and any unlisted shape — a
          // wasm init failure, OPFS unavailable in private browsing, a dead
          // worker's RpcLifecycleError — lost the edit AND rebased the outline
          // (pkm-9x6u). A one-item blocklist is the honest rule.
          //
          // A `quota` flag was also emitted here, to drive an offline
          // read-only mode. Nothing could ever set it — the opfs-sahpool VFS
          // reports an exhausted disk as a bare SQLITE_IOERR (pkm-avag) — so
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
          // durable batches that preceded them (pkm-49eh). countPending()
          // may read a count that a concurrent drain is about to shrink. An
          // over-count delays this entry, and until the durable queue is
          // next observed empty (which clears every count) a batch persisted
          // after it can go out first; what a stale count can never do is
          // lose the ops, which is the property that matters here.
          const durableAhead = fallback.length === 0
            ? await countPending() : durableSinceFallback;
          // countPending() is a worker RPC, so dispose() can have run its
          // settle loop while it was in flight: an entry appended now would
          // leave `delivered` pending forever, and every holder of that
          // promise leaking with it.
          if (qstate.disposed) {
            resolveDelivery({
              status: "failed", error: new Error("op queue disposed"),
            });
            return;
          }
          fallback.push({
            batchId,
            ops,
            durableAhead,
            resolve: resolveDelivery,
          });
          durableSinceFallback = 0;
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
      // succeeds it merely re-resolves a settled promise, which is a no-op.
      for (const entry of fallback) entry.resolve({ status: "failed", error });
    },
    onPending: pending.add,
    onUnsentInMemory: unsentInMemory.add,
    onPoisonPending: poisonPending.add,
    onPoisonMarkFailed: poisonMarkFailed.add,
    onPoison: poison.add,
    poisonMarkIntents: () => [...poisonMarkIntents],
    retryPoisonMarks: markRetainedPoison,
  };
}

export function createOpQueue(replica: Replica,
                              onDesync: (error: unknown) => void,
                              onDrain: (outcome: DrainOutcome) => void =
                                () => undefined): OpQueue {
  return createReplicaQueue(replica, onDesync, onDrain);
}
