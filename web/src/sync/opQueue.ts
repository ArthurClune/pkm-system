// pattern: Imperative Shell
// The write pump. With a replica (pkm-y8p0): every batch is persisted in
// the replica's pending_ops table (durable across restarts), applied
// optimistically there, then drained to POST /api/ops with its batch_id —
// a retry after a lost acknowledgement dedups server-side instead of
// double-applying. A poisoned batch (server 4xx) is set aside and
// surfaced, never retried forever (spec section 6); network errors stop
// the pump until the next kick/reconnect, queue intact.
//
// Without a replica (no-replica mode: wasm/OPFS unavailable), the
// pre-offline in-memory behaviour is preserved verbatim: same-tick ops
// coalesce into one batch, a failed batch clears the queue and reports
// desync, and while the socket is down ops are preserved in memory and
// flushed on reconnect as the newest last-write-wins writers.
import { ApiError, apiFetch } from "../api/client";
import type { BlockOp } from "../api/ops";
import type { Replica } from "../replica/client";
import { ReplicaError } from "../replica/rpc";
import { newUid } from "../uid";

/** Stable per-tab id: the server echoes it on the websocket so this tab can
 * skip its own (already optimistically applied) batches. */
export const clientId = newUid();

const MAX_BATCH = 500; // OpBatch.ops max_length on the server

export interface OpQueue {
  enqueue(ops: BlockOp[]): void;
  /** Pause (false) or resume (true) HTTP pumping. Enqueue keeps preserving
   * ops either way; resuming flushes whatever accumulated while offline. */
  setOnline(online: boolean): void;
  /** Resolves once nothing is pending or in flight (tests, smoke). */
  idle(): Promise<void>;
  /** Pending (non-poisoned) batch count changes; replica-backed only. */
  onPending(fn: (n: number) => void): () => void;
  /** A batch the server rejected (4xx) was set aside. */
  onPoison(fn: (e: unknown) => void): () => void;
  /** The replica could not persist an edit (storage quota exhausted). */
  onQuota(fn: (e: unknown) => void): () => void;
}

type Listener<T> = (v: T) => void;

function listeners<T>() {
  const set = new Set<Listener<T>>();
  return {
    add(fn: Listener<T>): () => void {
      set.add(fn);
      return () => { set.delete(fn); };
    },
    emit(v: T) { set.forEach((fn) => fn(v)); },
  };
}

function createReplicaQueue(replica: Replica,
                            onDesync: (e: unknown) => void): OpQueue {
  let online = true;
  // Persistence and pumping are decoupled on purpose: replica.enqueue
  // (durability) must never wait on a drain's network round-trip, or a
  // reload during one slow POST would lose every edit queued behind it.
  let persistChain = Promise.resolve();
  let drainRun: Promise<void> | null = null;
  let drainAgain = false;
  const pending = listeners<number>();
  const poison = listeners<unknown>();
  const quota = listeners<unknown>();

  const drainLoop = async (): Promise<void> => {
    while (online) {
      const batch = await replica.nextBatch();
      if (batch === null) return;
      try {
        await apiFetch("/api/ops", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: clientId,
                                 batch_id: batch.batch_id, ops: batch.ops }),
        });
      } catch (e: unknown) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          // the server rejected this exact payload: retrying is futile.
          // Set it aside so the rest of the queue can flow.
          const res = await replica.markPoisoned(batch.id, String(e));
          pending.emit(res.pending);
          poison.emit(e);
          continue;
        }
        return; // network/5xx: keep the batch, retry on next kick
      }
      const res = await replica.deleteBatch(batch.id);
      pending.emit(res.pending);
    }
  };

  /** Single-flight pump: at most one drain loop runs; a kick during a
   * run schedules exactly one follow-up pass. */
  const kick = (): void => {
    if (drainRun) {
      drainAgain = true;
      return;
    }
    drainRun = (async () => {
      do {
        drainAgain = false;
        await drainLoop();
      } while (drainAgain);
    })()
      // a worker RPC failure must not wedge idle(); the batch is durable
      // and the next kick (edit or reconnect) retries it
      .catch(() => undefined)
      .finally(() => { drainRun = null; });
  };

  return {
    enqueue(ops) {
      if (ops.length === 0) return;
      const work = async () => {
        try {
          const res = await replica.enqueue(ops);
          pending.emit(res.pending);
        } catch (e: unknown) {
          if (e instanceof ReplicaError && e.quota) {
            // an unpersisted edit must not look accepted (spec section 6):
            // offline this freezes the editor (canEdit drops); online we
            // degrade to a direct legacy post so the edit still lands
            quota.emit(e);
            try {
              await apiFetch("/api/ops", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ client_id: clientId, ops }),
              });
            } catch {
              // offline with a full disk: the quota state has already
              // frozen the editor; nothing else can hold this edit
            }
            return;
          }
          onDesync(e);
          return;
        }
        kick();
      };
      persistChain = persistChain.then(work, work);
    },
    setOnline(next) {
      online = next;
      // kick even when we already thought we were online: a fresh queue
      // starts online, but the durable pending_ops table can hold batches
      // from a previous page load (a reload kills in-flight POSTs), and
      // the first socket connect is the only guaranteed drain moment
      if (online) kick();
    },
    async idle() {
      // quiescent = the persist chain we awaited is still the tail AND no
      // drain is running (enqueue's work kicks the pump synchronously
      // before resolving, so a fresh drainRun is visible here)
      for (;;) {
        const tail = persistChain;
        await tail;
        const run = drainRun;
        if (run) await run;
        if (tail === persistChain && drainRun === null) return;
      }
    },
    onPending: pending.add,
    onPoison: poison.add,
    onQuota: quota.add,
  };
}

function createLegacyQueue(onDesync: (e: unknown) => void): OpQueue {
  let pending: BlockOp[] = [];
  let inflight: Promise<void> | null = null;
  // A freshly created queue is online; the shell pauses it on disconnect.
  let online = true;

  const pump = async (): Promise<void> => {
    // Re-check online each iteration: if the socket dropped mid-pump, the
    // batch already in flight finishes but no further batch is sent.
    while (online && pending.length > 0) {
      const batch = pending.slice(0, MAX_BATCH);
      pending = pending.slice(batch.length);
      try {
        await apiFetch("/api/ops", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: clientId, ops: batch }),
        });
      } catch (e: unknown) {
        pending = [];
        try {
          onDesync(e);
        } catch {
          // a throwing desync callback must not poison the queue
        }
        return;
      }
    }
  };

  const kick = () => {
    if (!online) return; // offline: preserve pending, pump nothing
    if (inflight) return; // the running pump loop will pick pending up
    // microtask delay so every op from one keystroke joins one batch
    inflight = Promise.resolve().then(async () => {
      try {
        await pump();
      } finally {
        inflight = null;
        // ops enqueued while the pump was tearing down (e.g. from a
        // re-entrant onDesync) must start a fresh pump, not strand
        if (pending.length > 0) kick();
      }
    });
  };

  return {
    enqueue(ops: BlockOp[]) {
      if (ops.length === 0) return;
      pending.push(...ops);
      kick();
    },
    setOnline(next: boolean) {
      if (next === online) return;
      online = next;
      if (online) kick(); // flush whatever was preserved while offline
    },
    async idle() {
      while (inflight) await inflight;
    },
    onPending: () => () => undefined,
    onPoison: () => () => undefined,
    onQuota: () => () => undefined,
  };
}

export function createOpQueue(replica: Replica | null,
                              onDesync: (e: unknown) => void): OpQueue {
  return replica ? createReplicaQueue(replica, onDesync)
                 : createLegacyQueue(onDesync);
}
