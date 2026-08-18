// Test fake (coverage-excluded like src/test-helpers.ts): an in-memory Replica
// mirroring queue.ts semantics. Not shipped — imported only by tests.
import type { PendingBatch, Replica } from "../replica/client";

/** In-memory replica queue mirroring queue.ts semantics. `enqueued` records
 * batch ids in enqueue order: the ids are caller-minted now, so assertions
 * read them back instead of pinning literals. */
export function memReplica(over: Partial<Replica> = {}): Replica & {
  rows: PendingBatch[]; enqueued: string[];
} {
  const rows: PendingBatch[] = [];
  const enqueued: string[] = [];
  let nextId = 1;
  const pending = () => rows.filter((r) => !r.poisoned).length;
  const replica: Replica & { rows: PendingBatch[]; enqueued: string[] } = {
    rows,
    enqueued,
    init: async () => ({ empty: false, cursor: 0,
                         schemaMismatch: false, pendingBatches: [] }),
    applySnapshot: async () => undefined,
    applyChanges: async () => ({ status: "applied", cursor: 0 }),
    enqueue: async (ops, batchId) => {
      enqueued.push(batchId);
      rows.push({ id: nextId, batch_id: batchId, ops, poisoned: false });
      nextId += 1;
      return { pending: pending(), batchId };
    },
    nextBatch: async () => rows.find((r) => !r.poisoned) ?? null,
    pendingBatches: async () => [...rows],
    poisonedBatches: async () => [],
    deleteBatch: async (id) => {
      rows.splice(rows.findIndex((r) => r.id === id), 1);
      return { pending: pending() };
    },
    markPoisoned: async (id) => {
      rows.find((r) => r.id === id)!.poisoned = true;
      return { pending: pending() };
    },
    pendingCount: async () => pending(),
    localApi: async () => ({ handled: false as const }),
    prepareRecovery: async () => ({ token: "lease-1", batches: [...rows] }),
    commitRecovery: async () => undefined,
    abortRecovery: async () => undefined,
    reset: async () => undefined,
    dispose: async () => undefined,
  };
  return Object.assign(replica, over);
}
