// @vitest-environment node
import { expect, test, vi } from "vitest";
import { applySnapshot, type Snapshot } from "./apply";
import { availabilityOf, ReplicaUnavailableError } from "./errors";
import { openRawTestDb } from "./testDb";
import { buildHandlers } from "./workerHandlers";

const SNAP: Snapshot = {
  generation: "gen-1", plain_space_title_canonicalization: false, seq: 5,
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
    .resolves.toEqual({ pending: 3, batchId: "batch-new" });
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

test("commit detects an error-only durable row mutation hidden from the public lease", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({
    openDb: async () => t.db,
    newBatchId: () => "batch-error",
  });
  await handlers.init(undefined);
  await handlers.enqueue([{ op: "delete", uid: "uid_error" }]);
  await handlers.markPoisoned({ id: 1, error: "first rejection" });
  const lease = await handlers.prepareRecovery(undefined) as {
    token: string;
    batches: Array<Record<string, unknown>>;
  };
  expect(lease.batches[0]).not.toHaveProperty("error");

  t.db.exec("UPDATE pending_ops SET error = ? WHERE id = 1", ["changed only error"]);

  await expect(handlers.commitRecovery({
    token: lease.token,
    input: { kind: "rebase", snapshot: SNAP },
  })).rejects.toThrow("pending rows changed during recovery");
});

test("markPoisoned validates batch identity and remains idempotent", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({
    openDb: async () => t.db,
    newBatchId: () => "replacement-batch",
  });
  await handlers.init(undefined);
  await handlers.enqueue([{ op: "delete", uid: "uid_new" }]);

  await expect(handlers.markPoisoned({
    id: 1, batchId: "deleted-batch", error: "old rejection",
  })).resolves.toEqual({ pending: 1, matched: false });
  await expect(handlers.pendingBatches(undefined)).resolves.toEqual([
    expect.objectContaining({
      id: 1, batch_id: "replacement-batch", poisoned: false,
    }),
  ]);

  await expect(handlers.markPoisoned({
    id: 1, batchId: "replacement-batch", error: "current rejection",
  })).resolves.toEqual({ pending: 0, matched: true });
  await expect(handlers.markPoisoned({
    id: 1, batchId: "replacement-batch", error: "same rejection retry",
  })).resolves.toEqual({ pending: 0, matched: true });
});

test("schema reset removes obsolete user and virtual-table objects atomically", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({ openDb: async () => t.db });
  await handlers.init(undefined);
  t.db.exec("CREATE TABLE obsolete_cache(id INTEGER PRIMARY KEY, value TEXT)");
  t.db.exec("CREATE VIEW obsolete_view AS SELECT id FROM obsolete_cache");
  t.db.exec("CREATE VIRTUAL TABLE obsolete_fts USING fts5(value)");
  const lease = await handlers.prepareRecovery(undefined) as { token: string };

  await handlers.commitRecovery({
    token: lease.token,
    input: { kind: "reset", snapshot: SNAP },
  });

  expect(t.db.select<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE name LIKE 'obsolete_%' ORDER BY name",
  )).toEqual([]);
  expect(t.db.select("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
});

test("an acquired recovery lease expires if its client forgets the token", async () => {
  vi.useFakeTimers();
  try {
    let clock = 0;
    const t = await openRawTestDb();
    const handlers = buildHandlers({
      openDb: async () => t.db,
      clockMs: () => clock,
      newBatchId: () => "batch-after-expiry",
    });
    await handlers.init(undefined);
    const lease = await handlers.prepareRecovery({ expiresAtMs: 100 }) as {
      token: string;
    };
    const later = handlers.enqueue([{ op: "delete", uid: "uid_later" }]);

    clock = 100;
    await vi.advanceTimersByTimeAsync(100);

    await expect(later).resolves.toEqual({
      pending: 1, batchId: "batch-after-expiry",
    });
    await expect(handlers.abortRecovery(lease.token))
      .rejects.toThrow("invalid or inactive recovery token");
  } finally {
    vi.useRealTimers();
  }
});

test("a failed open stays latched: init's rejection must not re-arm the database",
async () => {
  // pkm-bjae / pkm-61zt: SyncProvider lifts the op queue's recovery barrier on
  // the strength of init() rejecting with the latched ReplicaUnavailableError,
  // WITHOUT having read the poison table. If init's failure path cleared the
  // memoised open, the next handler call would attempt a fresh one — and in
  // the reload race that succeeds, letting the queue drain batches queued
  // behind an undiscovered poison row. One failed open therefore has to mean
  // online-only for the whole session.
  let opens = 0;
  const handlers = buildHandlers({
    openDb: async () => {
      opens += 1;
      throw new Error(
        "Access Handles cannot be created if there is another open Access Handle");
    },
  });

  await expect(handlers.poisonedBatches(undefined)).rejects.toThrow(/Access Handle/);
  expect(opens).toBe(1);

  await expect(handlers.init(undefined)).rejects.toThrow(/Access Handle/);

  // init() must not have re-armed the open: later handlers replay the
  // memoised rejection rather than trying again.
  await expect(handlers.nextBatch(undefined)).rejects.toThrow(/Access Handle/);
  await expect(handlers.poisonedBatches(undefined)).rejects.toThrow(/Access Handle/);
  expect(opens).toBe(1);
});

test("one failed open is replayed by EVERY handler, and opens only once", async () => {
  // Characterisation for pkm-q2jj: today this holds because db() is
  // `dbPromise ??= openDb()` and nothing clears the rejection. Task 3 replaces
  // that implicit mechanism with an explicit latch; this test must not notice.
  //
  // commitRecovery(), abortRecovery() and close() are deliberately excluded:
  // commitRecovery takes a lease token and is covered by its own recovery
  // tests; abortRecovery and close() never call db() at all on this path
  // (abortRecovery only touches the in-memory recovery gate, and close()
  // only clears dbPromise and calls the injected closeDb). prepareRecovery
  // takes no required payload (its own tests call it with undefined) and
  // does call db(), so it belongs in the list below. init() used to be
  // excluded here because it caught the open failure and returned
  // { ok: false }; now that it is just another handler (pkm-61zt), it belongs
  // in the list too.
  let opens = 0;
  const handlers = buildHandlers({
    openDb: async () => {
      opens += 1;
      throw new Error("OPFS is not available in this browser");
    },
  });

  const calls: Array<[string, unknown]> = [
    ["init", undefined],
    ["enqueue", [{ op: "delete", uid: "uid_b1" }]],
    ["nextBatch", undefined],
    ["deleteBatch", 1],
    ["markPoisoned", { id: 1, error: "e", batchId: "b" }],
    ["applySnapshot", SNAP],
    ["applyChanges", { feed: { reset: false, generation: "gen-1",
      plain_space_title_canonicalization: false, next_since: 0, latest_seq: 0,
      pages: [], blocks: [], sidebar: [], tombstones: [] },
      expectedPendingIds: [] }],
    ["pendingBatches", undefined],
    ["poisonedBatches", undefined],
    ["pendingCount", undefined],
    ["localApi", { method: "GET", path: "/api/page/AI", nowMs: 1 }],
    ["reset", undefined],
    ["prepareRecovery", undefined],
  ];
  for (const [method, payload] of calls) {
    await expect(handlers[method](payload), method).rejects.toThrow(/OPFS is not available/);
  }
  expect(opens).toBe(1);
});

test("the latched unavailable error is one typed object, and close() is its only reset",
async () => {
  let opens = 0;
  let fail = true;
  const t = await openRawTestDb();
  const handlers = buildHandlers({
    openDb: async () => {
      opens += 1;
      if (fail) throw new Error("OPFS is not available in this browser");
      return t.db;
    },
  });

  const first = await handlers.pendingCount(undefined).catch((e: unknown) => e);
  expect(first).toBeInstanceOf(ReplicaUnavailableError);
  // The original message is preserved deliberately: it is the only
  // diagnostic a user-visible banner has. Retention itself no longer matches
  // on it (pkm-s7af made that a type check on this class instead).
  expect((first as Error).message).toBe("OPFS is not available in this browser");

  // Same object, not a fresh one per call: the fact is latched, not re-derived.
  const second = await handlers.nextBatch(undefined).catch((e: unknown) => e);
  expect(second).toBe(first);
  expect(opens).toBe(1);

  // Even a would-be-successful open is not attempted while the latch holds.
  fail = false;
  await expect(handlers.pendingCount(undefined)).rejects.toBe(first);
  expect(opens).toBe(1);

  // close() is the reset — and the only one.
  await expect(handlers.close(undefined)).resolves.toBeNull();
  // init() is what a real client calls on re-arm; it installs schema on the
  // fresh (schemaless) db from openRawTestDb, the way it would on a genuinely
  // new profile. Without it, pendingCount would query a table that does not
  // exist yet — and SyncProvider does hit that path on a fresh profile: it
  // calls pendingCount() from a mount effect with no dependency on init()
  // completing first (see pkm-za9j's recorded finding).
  await expect(handlers.init(undefined)).resolves.toMatchObject({ empty: true });
  await expect(handlers.pendingCount(undefined)).resolves.toBe(0);
  expect(opens).toBe(2);
});

test("init rejects with the latched error instead of reporting ok:false", async () => {
  // ok:false was the FIRST of five representations of one fact (pkm-q2jj): a
  // value that says what the latched rejection already says, kept in sync by
  // convention. With the worker owning the fact, init() is just another
  // handler.
  const handlers = buildHandlers({
    openDb: async () => { throw new Error("OPFS is not available in this browser"); },
  });
  const err = await handlers.init(undefined).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReplicaUnavailableError);
  expect(availabilityOf(err)).toBe("unusable");
});
