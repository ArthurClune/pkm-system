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
import { ackSeq } from "./opsAck";
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
   * nothing (pkm-0htf). */
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
  /** Drop retained mark intents without marking them (pkm-tu5k). The escape
   * from a profile whose replica can never open: needs no replica call. If
   * the replica later opens, the unmarked batch redelivers, the server
   * rejects it again, and the normal poison → repair flow handles it then. */
  discardPoisonIntents(): void;
  /** Deliver every lane entry that a durable batch (named by its batch_id)
   * follows, in order, before that batch may itself be POSTed. This is how
   * the recovery flush (replicaSync.flushBatches) — which posts leased
   * durable rows on its own, knowing nothing about the lane — gets the same
   * ordering guarantee the drain enforces on itself (pkm-5ekv): call it
   * before every batch that flush posts. A no-op when nothing in the lane
   * precedes `batchId`. Throws, and leaves the entry retained, on a POST
   * failure — a discard is the drain's decision alone, never this door's —
   * and throws if the queue is disposed. */
  deliverLaneAhead(batchId: string): Promise<void>;
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

/** Whether an /api/ops ack named any op the server skipped -- a block, or
 * create/move parent, it no longer had (see `ops_core.classify_missing_target`
 * and `render.render_ops_ack` on the server; `skipped` is present only when
 * non-empty). Read by hand exactly like ackSeq's `seq`, for the same reason:
 * `OpsAck` is not a `response_model`, so the OpenAPI schema types the ack as a
 * bare object and regenerating it is a no-op. Missing, absent, or malformed
 * (not an array) all mean nothing was skipped -- the honest reading of a
 * shape this loose is "no evidence of a skip", not a thrown error. */
function ackSkipped(ack: unknown): boolean {
  if (typeof ack !== "object" || ack === null) return false;
  const skipped = (ack as { skipped?: unknown }).skipped;
  return Array.isArray(skipped) && skipped.length > 0;
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
  /** This entry's position in lane-append order, assigned once at append
   * time from `laneAppended`. Compared against a durable batch's boundary in
   * `follows` to decide whether that batch may overtake it (see
   * laneHeadPrecedes) — ordering by identity, never by a count. */
  seq: number;
  resolve(outcome: DeliveryOutcome): void;
}

function createReplicaQueue(replica: Replica,
                            onDesync: (error: unknown) => void,
                            onDrain: (outcome: DrainOutcome) => void,
                            onSkipped: () => void): OpQueue {
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
  const poisonMarkUnmatched = listeners<void>();
  const deliveries = new Map<string, (outcome: DeliveryOutcome) => void>();
  const fallback: FallbackEntry[] = [];
  // Monotonic count of lane entries ever appended: the source of each
  // entry's `seq` and of the boundary a durable batch's `follows` mark
  // records (see FallbackEntry and laneHeadPrecedes).
  let laneAppended = 0;
  // batch_id -> the lane-append boundary that batch must wait behind: every
  // entry whose `seq` is less than this value was appended to the lane
  // before this durable batch was persisted, so it must be delivered first.
  // Only set for a durable batch THIS queue persisted while the lane was
  // non-empty (see enqueue's success path) — a durable row with no entry
  // here (a previous session's rows, the offline shim's create_page in
  // replica/localApi/router.ts) is ahead of the lane by default, since
  // laneHeadPrecedes treats a missing mark as a boundary of -1. A mark is
  // removed once its batch is delivered or rejected here, and the whole map
  // is cleared once the lane empties or nextBatch() observes the durable
  // queue empty, which catches batches flushed out of band.
  const follows = new Map<string, number>();
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
  // Each emission costs every subscriber a re-render, and in the app that is
  // one per mounted outline (pkm-qfee), so a count that did not move is not
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
    const unsent = fallback.length;
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

  /** True exactly when the fallback head must be delivered before `batchId`
   * may itself go out. `batchId === null` means nextBatch() observed the
   * durable queue empty, so any lane head qualifies outright — there is
   * nothing left for it to wait behind. Otherwise a durable batch this queue
   * never marked (see `follows`) is ahead of the lane by construction: the
   * lookup's `-1` default can never exceed a real (non-negative) seq. This is
   * the ONE predicate both the drain and deliverLaneAhead consult — ordering
   * is decided here, once, by batch identity. */
  const laneHeadPrecedes = (batchId: string | null): boolean => {
    const head = fallback[0];
    if (head === undefined) return false;
    if (batchId === null) return true;
    return head.seq < (follows.get(batchId) ?? -1);
  };

  /** Settle the fallback head with `outcome`, shifting it out of the lane
   * ONLY if it is still at the front. The drain and the recovery flush
   * (replicaSync.flushBatches, via deliverLaneAhead) may race delivering the
   * very same head: a duplicate POST of the same batch_id is a harmless
   * server replay, but a double shift would drop the entry behind it instead
   * of settling this one twice. Clearing `follows` here (rather than per
   * removed mark) is what keeps an emptied lane from leaving a boundary
   * behind for the next entry appended to inherit. */
  const settleLaneHead = (
    head: FallbackEntry, outcome: DeliveryOutcome,
  ): void => {
    if (fallback[0] === head) {
      fallback.shift();
      if (fallback.length === 0) follows.clear();
    }
    head.resolve(outcome);
    emitPending();
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
   * decrement it used to be (pkm-yavj). */
  const rememberPoisonMark = (event: PoisonEvent): void => {
    const key = `${event.rowId}\u0000${event.batchId}`;
    const retained = new Map(poisonMarkIntents.map((intent) =>
      [`${intent.rowId}\u0000${intent.batchId}`, intent]));
    retained.set(key, event);
    poisonMarkIntents = [...retained.values()].sort((a, b) =>
      a.rowId - b.rowId || a.batchId.localeCompare(b.batchId));
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
        // past a KNOWN-rejected batch safe (pkm-tu5k).
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
   * laneHeadPrecedes, so this only posts and settles. Returns the outcome the
   * drain must report, or null to keep looping. */
  const deliverLaneHead = async (
    head: FallbackEntry,
  ): Promise<DrainOutcome | null> => {
    let ack: unknown;
    try {
      ack = await postOps(head.ops, head.batchId);
    } catch (error: unknown) {
      if (isTerminalRejection(error)) {
        // A lane entry has no durable row to poison, so terminal means
        // discarded: drop exactly the rejected entry — the only discard
        // this queue makes on its own — hold later entries behind the
        // recovery barrier, and let onDesync run the authoritative repair
        // that resumes it.
        dispatch({ type: "pause" });
        settleLaneHead(head, { status: "failed", error });
        try { onDesync(error); } catch { /* listener isolation */ }
        return blocked("recovering", error);
      }
      return failed(error);
    }
    // This batch committed (skipped ops are not a rejection); the ack's
    // skipped list is consulted regardless of `unavailable`: a replica-backed
    // tab's own feed tombstones the replica row, but no resync event follows
    // from that alone, so the view keeps the ghost until something else bumps
    // resync. The extra refetch is harmless when the feed also converges the
    // row.
    if (ackSkipped(ack)) {
      try { onSkipped(); } catch { /* listener isolation */ }
    }
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
    follows.delete(batch.batch_id);
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
     * server lands it under a daily-note `[[conflict]]` header instead of
     * silently LWW-overwriting the newer lane op.
     *
     * pendingCount is deliberately NOT zeroed: durable rows persisted before
     * the replica died are genuinely undelivered and belong in the pending
     * diagnostic. Outstanding delivery promises are deliberately left
     * unsettled, exactly as they are today — dispose() is what settles them —
     * because resolving them "delivered" would be a lie and resolving them
     * "failed" would change what the outline session's replay does. */
    const deferDurableQueue = (): DrainOutcome | null => {
      if (fallback.length > 0) return null;
      if (drainAgain) return null;
      return { status: "drained" };
    };

    for (;;) {
      drainAgain = false;
      if (unavailable !== null) {
        const head = fallback[0];
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
        if (unavailable === null) return failed(error);
        const outcome = deferDurableQueue();
        if (outcome !== null) return outcome;
        continue;
      }
      // The lane now needs this read before it can go out — a batch persisted
      // after the head is what used to let it overtake (pkm-5ekv) — so a
      // transient nextBatch() failure (caught above) delays the lane through
      // the normal backoff rather than losing it.
      if (laneHeadPrecedes(batch?.batch_id ?? null)) {
        const outcome = await deliverLaneHead(fallback[0]!);
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
        follows.clear();
        // Published, not just assigned: an empty durable queue is exactly the
        // case where a stale over-count is cleared, and a banner still showing
        // the old number is the visible half of that.
        setPendingCount(0);
        if (fallback.length > 0) continue;
        if (drainAgain) continue;
        return { status: "drained" };
      }
      let ack: unknown;
      try {
        ack = await postOps(batch.ops, batch.batch_id);
      } catch (error: unknown) {
        if (isTerminalRejection(error)) {
          return rejectDurableBatch(batch, error);
        }
        return failed(error);
      }
      // A committed durable batch whose ack names a skipped op needs the view
      // told, same as the lane: the replica tombstones the row from its own
      // feed, but no resync event follows from that alone.
      if (ackSkipped(ack)) {
        try { onSkipped(); } catch { /* listener isolation */ }
      }
      let result;
      try {
        // The ack's seq lets a pull that snapshotted this batch as pending
        // accept a window that already carries it, instead of refetching
        // (pkm-ur2n: the save's WS nudge and this ack race).
        result = await replica.deleteBatch(batch.id, batch.batch_id, ackSeq(ack));
      } catch (error: unknown) {
        noteReplicaFailure(error);
        return failed(error);
      }
      finishDelivery(batch.batch_id, { status: "delivered" });
      // This batch is delivered, so its mark (if it had one — see `follows`)
      // no longer needs to hold any lane head behind it.
      follows.delete(batch.batch_id);
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
        try { onDrain(outcome); } catch { /* observer isolation */ }
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
          // Persisted durably while the lane still holds entries: every one
          // of them was appended before this batch existed, so it follows
          // all of them (see `follows` and laneHeadPrecedes). Nothing to mark
          // when the lane is empty — there is nothing for this batch to wait
          // behind.
          if (fallback.length > 0) follows.set(batchId, laneAppended);
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
          // durable batches that preceded them (pkm-49eh) — by construction,
          // not by count: this entry gets the next `seq`, and any durable
          // batch already persisted is simply unmarked in `follows`, which
          // laneHeadPrecedes treats as ahead of the lane regardless.
          fallback.push({
            batchId, ops, seq: laneAppended, resolve: resolveDelivery,
          });
          laneAppended += 1;
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
      while (laneHeadPrecedes(batchId)) {
        const head = fallback[0]!;
        // Left retained on any error — a discard is the drain's decision
        // alone, and this door never makes it.
        await postOps(head.ops, head.batchId);
        settleLaneHead(head, { status: "delivered" });
      }
    },
  };
}

export function createOpQueue(replica: Replica,
                              onDesync: (error: unknown) => void,
                              onDrain: (outcome: DrainOutcome) => void =
                                () => undefined,
                              /** Either delivery path's ack named a skipped
                               * op (see deliverLaneHead and the durable batch
                               * loop in runDrain) -- the active view is stale
                               * and must refetch. Never a desync: the batch
                               * committed, so nothing here is retried or
                               * discarded. */
                              onSkipped: () => void =
                                () => undefined): OpQueue {
  return createReplicaQueue(replica, onDesync, onDrain, onSkipped);
}
