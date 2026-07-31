// pattern: Imperative Shell
// Persistence completion and HTTP delivery are deliberately separate: a
// WriteTicket settles when the active storage accepts a write, while drain()
// reports whether every retained write reached the server.
import { ApiError, apiFetch } from "../api/client";
import type { BlockOp } from "../api/ops";
import type { PoisonedBatch, Replica } from "../replica/client";
import { isSahPoolContention } from "../replica/openRetry";
import { isPoolExhausted } from "../replica/poolCapacity";
import { ReplicaError } from "../replica/rpc";
import { newUid } from "../uid";
import { createQueueState, terminalReason, transitionQueue,
         type QueueEffect, type QueueEvent } from "./queueState";

export const clientId = newUid();

const MAX_BATCH = 500;

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
  /** Internal recovery ownership signal. Unlike onPoison, this fires before
   * the durable poison mark so a recovery lease cannot flush a stale row. */
  onPoisonPending(fn: () => void): () => void;
  onPoisonMarkFailed(fn: (failure: PoisonMarkFailure) => void): () => void;
  onPoison(fn: (event: PoisonEvent) => void): () => void;
  onQuota(fn: (e: unknown) => void): () => void;
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

function postOps(ops: BlockOp[], batchId?: string): Promise<unknown> {
  return apiFetch("/api/ops", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      ...(batchId === undefined ? {} : { batch_id: batchId }),
      ops,
    }),
  });
}

/** An enqueue whose ops could not be persisted locally (quota, OPFS
 * access-handle contention, exhausted SAH pool). Retained in FIFO order and
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
  const poisonPending = listeners<void>();
  const poisonMarkFailed = listeners<PoisonMarkFailure>();
  const poison = listeners<PoisonEvent>();
  const quota = listeners<unknown>();
  const deliveries = new Map<string, (outcome: DeliveryOutcome) => void>();
  const unidentifiedDeliveries: Array<{
    position: number;
    resolve(outcome: DeliveryOutcome): void;
  }> = [];
  const fallback: FallbackEntry[] = [];
  // Durable batches persisted since the last fallback entry was appended:
  // they sit BEHIND that entry and must not overtake it.
  let durableSinceFallback = 0;

  /** Durable rows plus retained in-memory entries: what the UI must show as
   * "changes pending", and what a blocked drain reports. */
  const totalPending = (): number => pendingCount + fallback.length;
  const emitPending = (): void => { pending.emit(totalPending()); };

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

  const finishDelivery = (batchId: string, outcome: DeliveryOutcome): void => {
    const resolve = deliveries.get(batchId);
    if (!resolve) return;
    deliveries.delete(batchId);
    resolve(outcome);
  };

  const finishAllDeliveries = (outcome: DeliveryOutcome): void => {
    for (const resolve of deliveries.values()) resolve(outcome);
    deliveries.clear();
    while (unidentifiedDeliveries.length > 0) {
      unidentifiedDeliveries.shift()!.resolve(outcome);
    }
  };

  /** Older workers omitted enqueue batch ids. Their returned pending count is
   * the ticket's FIFO position among deliverable durable rows. */
  const finishObservedUnidentified = (outcome: DeliveryOutcome): void => {
    const retained: typeof unidentifiedDeliveries = [];
    for (const delivery of unidentifiedDeliveries) {
      if (delivery.position === 1) delivery.resolve(outcome);
      else retained.push({ ...delivery, position: delivery.position - 1 });
    }
    unidentifiedDeliveries.splice(0, unidentifiedDeliveries.length, ...retained);
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
    try {
      pendingCount = await replica.pendingCount();
    } catch {
      // The last observed count is still the best terminal diagnostic.
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
    let result: { pending: number; matched?: boolean } | null = null;
    const matchedIntents: PoisonEvent[] = [];
    for (const event of intents) {
      try {
        result = await replica.markPoisoned(event.rowId, JSON.stringify({
          status: event.status, message: event.message,
        }), event.batchId);
        if (result.matched !== false) matchedIntents.push(event);
      } catch (error: unknown) {
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

  const runDrain = async (): Promise<DrainOutcome> => {
    await settleAll();
    const initialBlock = terminalReason(qstate);
    if (initialBlock !== null) return blocked(initialBlock);

    for (;;) {
      drainAgain = false;
      const head = fallback[0];
      if (head !== undefined && head.durableAhead === 0) {
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
        continue;
      }
      let batch;
      try {
        batch = await replica.nextBatch();
      } catch (error: unknown) {
        return failed(error);
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
        for (const entry of fallback) entry.durableAhead = 0;
        durableSinceFallback = 0;
        if (fallback.length > 0) continue;
        if (drainAgain) continue;
        return { status: "drained" };
      }
      try {
        await postOps(batch.ops, batch.batch_id);
      } catch (error: unknown) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
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
          finishObservedUnidentified({ status: "failed", error });
          // Terminal for this batch: it is never POSTed again (the barrier
          // holds until the repair, and marking is retried, never delivery), so
          // it stops standing ahead of a retained entry from here.
          durableBatchSettled();
          try {
            await markRetainedPoison();
          } catch (rpcError: unknown) {
            return failed(rpcError);
          }
          return blocked("recovering");
        }
        return failed(error);
      }
      let result;
      try {
        result = await replica.deleteBatch(batch.id);
      } catch (error: unknown) {
        return failed(error);
      }
      pendingCount = result.pending;
      finishDelivery(batch.batch_id, { status: "delivered" });
      finishObservedUnidentified({ status: "delivered" });
      durableBatchSettled();
      if (pendingCount === 0) {
        // Test replicas and older workers may not return enqueue batch ids;
        // an empty durable queue proves those in-memory tickets delivered.
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
        // queue's missedKick handling -- but only for a "drained" outcome.
        // A blocked outcome's reason (offline/recovering/disposed/
        // retryable) still holds regardless of any kick that arrived during
        // cleanup, so redraining immediately would just repeat the same
        // block; worse, since drain() lets late callers share this very
        // promise, an unawaited background redrain kicked off here would
        // race those callers, who would observe the stale blocked result
        // instead of the redrain's outcome.
        const missedKick = outcome.status === "drained" && drainAgain;
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
        try {
          const result = await replica.enqueue(ops);
          pendingCount = result.pending;
          if (fallback.length > 0) durableSinceFallback += 1;
          if (qstate.disposed) {
            resolveDelivery({
              status: "failed", error: new Error("op queue disposed"),
            });
          } else if (result.batchId === undefined) {
            unidentifiedDeliveries.push({
              position: result.pending,
              resolve: resolveDelivery,
            });
          } else {
            deliveries.set(result.batchId, resolveDelivery);
          }
          emitPending();
          resolve({ status: "persisted", pending: pendingCount });
          if (!qstate.disposed) kick();
        } catch (error: unknown) {
          resolve({ status: "failed", error });
          const quotaExhausted = error instanceof ReplicaError && error.quota;
          // Local storage being unavailable is NOT a server rejection: the
          // replica is a cache, not the durability boundary. Quota exhaustion,
          // OPFS access-handle contention (a reload/second tab racing the
          // prior worker's SAH pool, pkm-c9hp) and an exhausted SAH pool with
          // no slot for SQLite's rollback journal (pkm-ndcu) all mean "cannot
          // persist locally right now" — never that the server refused the
          // edit. Firing onDesync would be the wrong answer, because its
          // authoritative repair would wipe the active outline to the
          // (edit-less) server state and detach the editor mid-keystroke, so
          // the ops are retained for ordered delivery by drain() rather than
          // posted from here.
          if (quotaExhausted || isSahPoolContention(error)
              || isPoolExhausted(error)) {
            if (quotaExhausted) quota.emit(error);
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
              batchId: newUid(),
              ops,
              durableAhead,
              resolve: resolveDelivery,
            });
            durableSinceFallback = 0;
            emitPending();
            kick();
          } else {
            resolveDelivery({ status: "failed", error });
            try { onDesync(error); } catch { /* listener isolation */ }
          }
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
    onPoisonPending: poisonPending.add,
    onPoisonMarkFailed: poisonMarkFailed.add,
    onPoison: poison.add,
    onQuota: quota.add,
    poisonMarkIntents: () => [...poisonMarkIntents],
    retryPoisonMarks: markRetainedPoison,
  };
}

function createLegacyQueue(onDesync: (error: unknown) => void,
                           onDrain: (outcome: DrainOutcome) => void): OpQueue {
  let pending: BlockOp[] = [];
  let qstate = createQueueState();
  let drainRun: Promise<DrainOutcome> | null = null;
  let drainAgain = false;
  let kickScheduled = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // A retried batch must resend a byte-identical payload under the same id
  // (the server binds batch_id to a sha256 of the ops), so this survives
  // across the separate runDrain() calls a 5xx retry makes: it is only
  // cleared on success or a terminal 4xx, never merely because runDrain
  // returned. Ops enqueued during a retry's backoff must not silently join
  // an already-attempted batch.
  let frozen: { id: string; ops: BlockOp[] } | null = null;
  const deliveries: Array<{
    remaining: number;
    resolve(outcome: DeliveryOutcome): void;
  }> = [];

  const deliverOps = (count: number): void => {
    let remaining = count;
    while (remaining > 0 && deliveries.length > 0) {
      const delivery = deliveries[0];
      const consumed = Math.min(remaining, delivery.remaining);
      delivery.remaining -= consumed;
      remaining -= consumed;
      if (delivery.remaining === 0) {
        deliveries.shift();
        delivery.resolve({ status: "delivered" });
      }
    }
  };

  const failDeliveries = (error: unknown): void => {
    while (deliveries.length > 0) {
      deliveries.shift()!.resolve({ status: "failed", error });
    }
  };

  /** Reject every ticket touched by the failed HTTP batch, including any
   * remainder of a ticket that crossed MAX_BATCH. Return the number of
   * pending ops owned by those terminal tickets so later tickets stay queued. */
  const rejectBatchDeliveries = (count: number, error: unknown): number => {
    let remaining = count;
    let discarded = 0;
    while (remaining > 0 && deliveries.length > 0) {
      const delivery = deliveries.shift()!;
      remaining -= Math.min(remaining, delivery.remaining);
      discarded += delivery.remaining;
      delivery.resolve({ status: "failed", error });
    }
    return discarded;
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

  const terminal = (
    reason: "offline" | "retryable" | "recovering" | "disposed",
    error?: unknown,
  ): DrainOutcome => ({
    status: "blocked", reason, pending: pending.length,
    ...(error === undefined ? {} : { error }),
  });

  const failed = (error: unknown): DrainOutcome => {
    const transition = dispatch({ type: "delivery-failed" });
    return terminal(transition.blockedReason!, error);
  };

  const runDrain = async (): Promise<DrainOutcome> => {
    const initialBlock = terminalReason(qstate);
    if (initialBlock !== null) return terminal(initialBlock);
    while (pending.length > 0) {
      frozen ??= { id: newUid(), ops: pending.slice(0, MAX_BATCH) };
      const batch = frozen.ops;
      try {
        await postOps(batch, frozen.id);
      } catch (error: unknown) {
        if (!(error instanceof ApiError) || error.status >= 500) {
          return failed(error);
        }
        // A rejected ticket is terminal, including a ticket whose remaining
        // ops cross this transport batch. Later tickets stay pending behind a
        // repair barrier and cannot POST until its owner explicitly resumes.
        dispatch({ type: "pause" });
        const discarded = rejectBatchDeliveries(batch.length, error);
        pending.splice(0, discarded);
        frozen = null;
        try { onDesync(error); } catch { /* listener isolation */ }
        // dispatch({ type: "pause" }) above unconditionally sets recovering
        // true (see queueState.ts), so this is never false: the loop always
        // returns here and never falls through to another iteration.
        return terminal("recovering", error);
      }
      pending.splice(0, batch.length);
      deliverOps(batch.length);
      frozen = null;
      dispatch({ type: "batch-succeeded" });
      const loopBlock = terminalReason(qstate);
      if (loopBlock !== null) return terminal(loopBlock);
    }
    return { status: "drained" };
  };

  const drain = (): Promise<DrainOutcome> => {
    if (drainRun) return drainRun;
    drainRun = runDrain()
      .catch(failed)
      .then((outcome) => {
        try { onDrain(outcome); } catch { /* observer isolation */ }
        return outcome;
      })
      .finally(() => {
        const missedKick = drainAgain;
        drainAgain = false;
        drainRun = null;
        if (missedKick && pending.length > 0) kick();
      });
    return drainRun;
  };

  const kick = (): void => {
    if (kickScheduled || !qstate.online || qstate.recovering ||
        qstate.disposed || retryTimer !== null) return;
    if (drainRun) {
      drainAgain = true;
      return;
    }
    kickScheduled = true;
    void Promise.resolve().then(() => {
      kickScheduled = false;
      return drain();
    });
  };

  return {
    enqueue(ops, scope) {
      if (ops.length > 0 && !qstate.disposed) {
        pending.push(...ops);
        let resolveDelivery!: (outcome: DeliveryOutcome) => void;
        const delivered = new Promise<DeliveryOutcome>((done) => {
          resolveDelivery = done;
        });
        deliveries.push({ remaining: ops.length, resolve: resolveDelivery });
        kick();
        return ticket(scope, Promise.resolve({
          status: "persisted", pending: pending.length,
        }), delivered);
      }
      if (qstate.disposed && ops.length > 0) {
        const error = new Error("op queue disposed");
        return ticket(scope, Promise.resolve({
          status: "failed", error,
        }), Promise.resolve({ status: "failed", error }));
      }
      return ticket(scope, Promise.resolve({
        status: "persisted", pending: pending.length,
      }), Promise.resolve({ status: "delivered" }));
    },
    settled: async () => undefined,
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
      failDeliveries(new Error("op queue disposed"));
    },
    onPending: () => () => undefined,
    onPoisonPending: () => () => undefined,
    onPoisonMarkFailed: () => () => undefined,
    onPoison: () => () => undefined,
    onQuota: () => () => undefined,
    poisonMarkIntents: () => [],
    retryPoisonMarks: async () => [],
  };
}

export function createOpQueue(replica: Replica | null,
                              onDesync: (error: unknown) => void,
                              onDrain: (outcome: DrainOutcome) => void =
                                () => undefined): OpQueue {
  return replica ? createReplicaQueue(replica, onDesync, onDrain)
                 : createLegacyQueue(onDesync, onDrain);
}
