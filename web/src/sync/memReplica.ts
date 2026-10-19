// Test fake (coverage-excluded like src/test-helpers.ts): an in-memory Replica
// mirroring queue.ts semantics. Not shipped — imported only by tests.
import type { BatchId } from "../api/brands";
import type { PendingBatch, Replica } from "../replica/client";
import { seqOf, pendingRowIdOf } from "../test-helpers";

/** In-memory replica queue mirroring queue.ts semantics. `enqueued` records
 * batch ids in enqueue order: the ids are caller-minted now, so assertions
 * read them back instead of pinning literals. */
export function memReplica(over: Partial<Replica> = {}): Replica & {
  rows: PendingBatch[]; enqueued: BatchId[];
} {
  const rows: PendingBatch[] = [];
  const enqueued: BatchId[] = [];
  let nextId = 1;
  const pending = () => rows.filter((r) => !r.poisoned).length;
  const replica: Replica & { rows: PendingBatch[]; enqueued: BatchId[] } = {
    rows,
    enqueued,
    init: async () => ({ empty: false, cursor: seqOf(0),
                         schemaMismatch: false, pendingBatches: [] }),
    applySnapshot: async () => ({ status: "applied" }),
    applyChanges: async () => ({ status: "applied", cursor: seqOf(0) }),
    enqueue: async (ops, batchId) => {
      if (ops.length > 0) {
        enqueued.push(batchId);
        rows.push({ id: pendingRowIdOf(nextId), batch_id: batchId, ops, poisoned: false });
        nextId += 1;
      }
      return { pending: pending(), batchId };
    },
    nextBatch: async () => rows.find((r) => !r.poisoned) ?? null,
    pendingBatches: async () => [...rows],
    poisonedBatches: async () => [],
    deleteBatch: async (id, batchId) => {
      const index = rows.findIndex((r) => r.id === id && r.batch_id === batchId);
      if (index !== -1) rows.splice(index, 1);
      return { pending: pending() };
    },
    markPoisoned: async (id, _error, batchId) => {
      const row = rows.find((r) => r.id === id && r.batch_id === batchId);
      if (row) row.poisoned = true;
      return { pending: pending(), matched: row !== undefined };
    },
    pendingCount: async () => pending(),
    localApi: async () => ({ handled: false as const }),
    prepareRecovery: async () => ({ token: "lease-1", batches: [...rows] }),
    commitRecovery: async () => undefined,
    abortRecovery: async () => undefined,
    reset: async () => undefined,
    diagnostics: async () => ({
      sqliteVersion: "mem", quickCheck: ["ok"],
      integrity: { blocks_fts: "ok", pages_fts: "ok" },
      counts: { pages: 0, blocks: 0, pending_ops: pending(),
                pages_fts_docsize: 0, blocks_fts_docsize: 0 },
      meta: { cursor: "0", generation: null, schema_version: null },
    }),
    dispose: async () => undefined,
  };
  return Object.assign(replica, over);
}
