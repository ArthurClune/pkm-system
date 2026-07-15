// @vitest-environment node
import { expect, test } from "vitest";
import { applySnapshot, type Snapshot } from "./apply";
import { openRawTestDb } from "./testDb";
import { buildHandlers } from "./workerHandlers";

const SNAP: Snapshot = {
  generation: "gen-1", seq: 5,
  pages: [{ id: 1, title: "AI", created_at: 1, updated_at: 1 }],
  blocks: [{ uid: "uid_b1", page_id: 1, parent_uid: null, order_idx: 0,
    text: "hello", heading: null, view_type: null, collapsed: 0,
    created_at: 1, updated_at: 1, refs: [] }],
  sidebar: [],
};

test("commit refuses changed durable rows and releases the recovery lease", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({
    openDb: async () => t.db,
    nowMs: () => 10,
    newBatchId: () => "batch-new",
  });
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await handlers.enqueue([{ op: "delete", uid: "uid_b1" }]);
  const lease = await handlers.prepareRecovery(undefined) as {
    token: string;
    batches: unknown[];
  };

  // Simulate an implementation bug or external writer bypassing the gate.
  t.db.exec(
    "INSERT INTO pending_ops(batch_id, ops_json) VALUES (?, ?)",
    ["bypassed", JSON.stringify([{ op: "delete", uid: "uid_x1" }])],
  );

  await expect(handlers.commitRecovery({
    token: lease.token,
    input: { kind: "reset", snapshot: SNAP },
  })).rejects.toThrow("pending rows changed during recovery");
  await expect(handlers.abortRecovery(lease.token))
    .rejects.toThrow("invalid or inactive recovery token");

  // A failed commit released exactly once, so later mutations are not wedged.
  await expect(handlers.enqueue([{ op: "delete", uid: "uid_x2" }]))
    .resolves.toEqual({ pending: 3 });
});

test("abort rejects invalid and double-used recovery tokens", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({
    openDb: async () => t.db,
  });
  await handlers.init(undefined);
  const lease = await handlers.prepareRecovery(undefined) as { token: string };

  await expect(handlers.abortRecovery("wrong-token"))
    .rejects.toThrow("invalid or inactive recovery token");
  await expect(handlers.abortRecovery(lease.token)).resolves.toBeNull();
  await expect(handlers.abortRecovery(lease.token))
    .rejects.toThrow("invalid or inactive recovery token");
});

test("rebase preserves and reapplies stable pending rows, then rejects token reuse", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({
    openDb: async () => t.db,
    nowMs: () => 10,
    newBatchId: () => "batch-local",
    newRecoveryToken: () => "lease-rebase",
  });
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await handlers.enqueue([
    { op: "update_text", uid: "uid_b1", text: "local pending" },
  ]);
  const lease = await handlers.prepareRecovery(undefined) as { token: string };

  await expect(handlers.commitRecovery({
    token: lease.token,
    input: {
      kind: "rebase",
      snapshot: {
        ...SNAP,
        blocks: [{ ...SNAP.blocks[0], text: "server authoritative" }],
      },
    },
  })).resolves.toBeNull();

  expect(t.db.select("SELECT text FROM blocks WHERE uid='uid_b1'"))
    .toEqual([{ text: "local pending" }]);
  expect(t.db.select("SELECT batch_id FROM pending_ops"))
    .toEqual([{ batch_id: "batch-local" }]);
  await expect(handlers.commitRecovery({
    token: lease.token,
    input: { kind: "rebase", snapshot: SNAP },
  })).rejects.toThrow("invalid or inactive recovery token");
});

test("a reset commit rolls back schema rebuild when snapshot application fails", async () => {
  const t = await openRawTestDb();
  let failSnapshot = false;
  const handlers = buildHandlers({
    openDb: async () => t.db,
    nowMs: () => 10,
    newBatchId: () => "batch-retained",
    applySnapshot: (db, snapshot, nowMs) => {
      if (failSnapshot) {
        db.exec("INSERT INTO pages(id, title) VALUES (999, 'partial')");
        throw new Error("snapshot apply failed");
      }
      applySnapshot(db, snapshot, nowMs);
    },
  });
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await handlers.enqueue([{ op: "delete", uid: "uid_b1" }]);
  await handlers.markPoisoned({ id: 1, error: "rejected" });
  const blocksBefore = t.db.select("SELECT uid, text FROM blocks ORDER BY uid");
  const lease = await handlers.prepareRecovery(undefined) as { token: string };
  failSnapshot = true;

  await expect(handlers.commitRecovery({
    token: lease.token,
    input: { kind: "reset", snapshot: SNAP },
  })).rejects.toThrow("snapshot apply failed");

  await expect(handlers.pendingBatches(undefined)).resolves.toEqual([{
    id: 1,
    batch_id: "batch-retained",
    ops: [{ op: "delete", uid: "uid_b1" }],
    poisoned: true,
  }]);
  expect(t.db.select("SELECT id FROM pages WHERE id=999")).toEqual([]);
  expect(t.db.select("SELECT uid, text FROM blocks ORDER BY uid"))
    .toEqual(blocksBefore);
});
