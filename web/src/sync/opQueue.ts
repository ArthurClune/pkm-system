// pattern: Imperative Shell
// Persistence completion and HTTP delivery are deliberately separate: a
// WriteTicket settles when the active storage accepts a write, while drain()
// reports whether every retained write reached the server.
import { ApiError, apiFetch } from "../api/client";
import type { BlockOp } from "../api/ops";
import type { PoisonedBatch, Replica } from "../replica/client";
import { ReplicaError } from "../replica/rpc";
import { newUid } from "../uid";

export const clientId = newUid();

const MAX_BATCH = 500;
const RETRY_DELAYS = [250, 1_000, 5_000] as const;

export type WriteOutcome =
  | { status: "persisted"; pending: number }
  | { status: "failed"; error: unknown };

export interface WriteTicket {
  id: string;
  scope: readonly string[];
  settled: Promise<WriteOutcome>;
}

export interface PoisonEvent extends PoisonedBatch {}

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
  onPoison(fn: (event: PoisonEvent) => void): () => void;
  onQuota(fn: (e: unknown) => void): () => void;
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
                settled: Promise<WriteOutcome>): WriteTicket {
  return { id: `write-${nextTicket++}`, scope: scope ?? [], settled };
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

function createReplicaQueue(replica: Replica,
                            onDesync: (error: unknown) => void,
                            onDrain: (outcome: DrainOutcome) => void): OpQueue {
  let online = true;
  let recovering = false;
  let disposed = false;
  let pendingCount = 0;
  let persistChain = Promise.resolve();
  let drainRun: Promise<DrainOutcome> | null = null;
  let drainAgain = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryIndex = 0;
  const pending = listeners<number>();
  const poison = listeners<PoisonEvent>();
  const quota = listeners<unknown>();

  const cancelRetry = (reset: boolean): void => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    if (reset) retryIndex = 0;
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
  ): Promise<DrainOutcome> => ({
    status: "blocked",
    reason,
    pending: await countPending(),
    ...(error === undefined ? {} : { error }),
  });

  const terminalReason = (): "offline" | "recovering" | "disposed" | null =>
    disposed ? "disposed"
      : recovering ? "recovering"
        : !online ? "offline" : null;

  const scheduleRetry = (): void => {
    if (!online || recovering || disposed || retryTimer !== null) return;
    const delay = RETRY_DELAYS[Math.min(retryIndex, RETRY_DELAYS.length - 1)];
    retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS.length - 1);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void drain();
    }, delay);
  };

  const failed = async (error: unknown): Promise<DrainOutcome> => {
    const count = await countPending();
    const reason = terminalReason();
    if (reason !== null) {
      return { status: "blocked", reason, pending: count, error };
    }
    scheduleRetry();
    return { status: "blocked", reason: "retryable", pending: count, error };
  };

  const runDrain = async (): Promise<DrainOutcome> => {
    await settleAll();
    if (disposed) return blocked("disposed");
    if (recovering) return blocked("recovering");
    if (!online) return blocked("offline");

    for (;;) {
      drainAgain = false;
      let batch;
      try {
        batch = await replica.nextBatch();
      } catch (error: unknown) {
        return failed(error);
      }
      if (batch === null) {
        pendingCount = 0;
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
          let result;
          try {
            result = await replica.markPoisoned(batch.id, JSON.stringify({
              status: event.status, message: event.message,
            }));
          } catch (rpcError: unknown) {
            return failed(rpcError);
          }
          pendingCount = result.pending;
          pending.emit(pendingCount);
          // Poison is a recovery barrier, not just an error notification.
          // Establish the pause synchronously before listeners can start the
          // authoritative rebase or any later durable row can POST.
          recovering = true;
          cancelRetry(false);
          poison.emit(event);
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
      pending.emit(pendingCount);
      cancelRetry(true);
      if (disposed) return blocked("disposed");
      if (recovering) return blocked("recovering");
      if (!online) return blocked("offline");
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
        return outcome;
      })
      .finally(() => { drainRun = null; });
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
        }));
      }
      let resolve!: (outcome: WriteOutcome) => void;
      const outcome = new Promise<WriteOutcome>((done) => { resolve = done; });
      const persist = async (): Promise<void> => {
        if (disposed) {
          resolve({ status: "failed", error: new Error("op queue disposed") });
          return;
        }
        try {
          const result = await replica.enqueue(ops);
          pendingCount = result.pending;
          pending.emit(pendingCount);
          resolve({ status: "persisted", pending: pendingCount });
          kick();
        } catch (error: unknown) {
          resolve({ status: "failed", error });
          if (error instanceof ReplicaError && error.quota) {
            quota.emit(error);
            try { await postOps(ops); } catch { /* best effort */ }
          } else {
            try { onDesync(error); } catch { /* listener isolation */ }
          }
        }
      };
      persistChain = persistChain.then(persist, persist);
      return ticket(scope, outcome);
    },
    settled: settleAll,
    drain,
    setOnline(next) {
      online = next;
      cancelRetry(true);
      if (online) kick();
    },
    pause() {
      recovering = true;
      cancelRetry(false);
    },
    resume() {
      if (!recovering) return;
      recovering = false;
      kick();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      online = false;
      cancelRetry(false);
    },
    onPending: pending.add,
    onPoison: poison.add,
    onQuota: quota.add,
  };
}

function createLegacyQueue(onDesync: (error: unknown) => void,
                           onDrain: (outcome: DrainOutcome) => void): OpQueue {
  let pending: BlockOp[] = [];
  let online = true;
  let recovering = false;
  let disposed = false;
  let drainRun: Promise<DrainOutcome> | null = null;
  let kickScheduled = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryIndex = 0;

  const cancelRetry = (reset: boolean): void => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    if (reset) retryIndex = 0;
  };

  const terminal = (
    reason: "offline" | "retryable" | "recovering" | "disposed",
    error?: unknown,
  ): DrainOutcome => ({
    status: "blocked", reason, pending: pending.length,
    ...(error === undefined ? {} : { error }),
  });

  const scheduleRetry = (): void => {
    if (!online || recovering || disposed || retryTimer !== null) return;
    const delay = RETRY_DELAYS[Math.min(retryIndex, RETRY_DELAYS.length - 1)];
    retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS.length - 1);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void drain();
    }, delay);
  };

  const failed = (error: unknown): DrainOutcome => {
    if (disposed) return terminal("disposed", error);
    if (recovering) return terminal("recovering", error);
    if (!online) return terminal("offline", error);
    scheduleRetry();
    return terminal("retryable", error);
  };

  const runDrain = async (): Promise<DrainOutcome> => {
    if (disposed) return terminal("disposed");
    if (recovering) return terminal("recovering");
    if (!online) return terminal("offline");
    while (pending.length > 0) {
      const batch = pending.slice(0, MAX_BATCH);
      try {
        await postOps(batch);
      } catch (error: unknown) {
        if (!(error instanceof ApiError) || error.status >= 500) {
          return failed(error);
        }
        pending = [];
        try { onDesync(error); } catch { /* listener isolation */ }
        continue;
      }
      pending.splice(0, batch.length);
      cancelRetry(true);
      if (disposed) return terminal("disposed");
      if (recovering) return terminal("recovering");
      if (!online) return terminal("offline");
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
      .finally(() => { drainRun = null; });
    return drainRun;
  };

  const kick = (): void => {
    if (kickScheduled || drainRun || !online || recovering || disposed) return;
    kickScheduled = true;
    void Promise.resolve().then(() => {
      kickScheduled = false;
      return drain();
    });
  };

  return {
    enqueue(ops, scope) {
      if (ops.length > 0 && !disposed) {
        pending.push(...ops);
        kick();
        return ticket(scope, Promise.resolve({
          status: "persisted", pending: pending.length,
        }));
      }
      if (disposed && ops.length > 0) {
        return ticket(scope, Promise.resolve({
          status: "failed", error: new Error("op queue disposed"),
        }));
      }
      return ticket(scope, Promise.resolve({
        status: "persisted", pending: pending.length,
      }));
    },
    settled: async () => undefined,
    drain,
    setOnline(next) {
      online = next;
      cancelRetry(true);
      if (online) kick();
    },
    pause() {
      recovering = true;
      cancelRetry(false);
    },
    resume() {
      if (!recovering) return;
      recovering = false;
      kick();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      online = false;
      cancelRetry(false);
    },
    onPending: () => () => undefined,
    onPoison: () => () => undefined,
    onQuota: () => () => undefined,
  };
}

export function createOpQueue(replica: Replica | null,
                              onDesync: (error: unknown) => void,
                              onDrain: (outcome: DrainOutcome) => void =
                                () => undefined): OpQueue {
  return replica ? createReplicaQueue(replica, onDesync, onDrain)
                 : createLegacyQueue(onDesync, onDrain);
}
