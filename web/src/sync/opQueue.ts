// pattern: Imperative Shell
// Serializes op batches to POST /api/ops: ops enqueued in the same tick
// coalesce into one batch, only one request is in flight at a time, and a
// failed batch clears the queue and reports desync — the caller refetches
// authoritative state (spec: server-authoritative, no offline merge).
import { apiFetch } from "../api/client";
import type { BlockOp } from "../api/ops";
import { newUid } from "../uid";

/** Stable per-tab id: the server echoes it on the websocket so this tab can
 * skip its own (already optimistically applied) batches. */
export const clientId = newUid();

const MAX_BATCH = 500; // OpBatch.ops max_length on the server

export interface OpQueue {
  enqueue(ops: BlockOp[]): void;
  /** Resolves once nothing is pending or in flight (tests, smoke). */
  idle(): Promise<void>;
}

export function createOpQueue(onDesync: (e: unknown) => void): OpQueue {
  let pending: BlockOp[] = [];
  let inflight: Promise<void> | null = null;

  const pump = async (): Promise<void> => {
    while (pending.length > 0) {
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
    async idle() {
      while (inflight) await inflight;
    },
  };
}
