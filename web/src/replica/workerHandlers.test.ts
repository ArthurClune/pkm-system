// @vitest-environment node
import { expect, test, vi } from "vitest";
import type { BatchId, SyncSeq } from "../api/brands";
import { applySnapshot, type Changes, type Snapshot } from "./apply";
import type { AckedBatch, PendingRowId, ReplicaDiagnostics } from "./client";
import { SCHEMA_VERSION } from "./clientSchema";
import { availabilityOf, ReplicaUnusableError } from "./errors";
import { type CarryStore, createCarryStore } from "./carryStore";
import type { ReplicaDb } from "./db";
import type { DurablePendingRow } from "./queue";
import { failingOnce, fakeCarryFiles, openRawTestDb, openTestDb,
         withDamagedFreelist } from "./testDb";
import { subtreeHash } from "./subtreeHash";
import { buildHandlers, type WorkerDeps } from "./workerHandlers";
import { ord, pageId, title, uid } from "../test-helpers";

const bid = (s: string): BatchId => s as BatchId;
const pid = (n: number): PendingRowId => n as PendingRowId;
const seq = (n: number): SyncSeq => n as SyncSeq;

const SNAP: Snapshot = {
  generation: "gen-1", plain_space_title_canonicalization: false, seq: (5 as SyncSeq),
  pages: [{ id: pageId(1), title: title("AI"), created_at: 1, updated_at: 1 }],
  blocks: [{ uid: uid("uid_b1"), page_id: pageId(1), parent_uid: null, order_idx: ord(0),
    text: "hello", heading: null, view_type: null, collapsed: 0,
    created_at: 1, updated_at: 1, refs: [] }],
  sidebar: [],
};

test("commit refuses changed durable rows and releases the recovery lease", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({
    openDb: async () => t.db,
    nowMs: () => 10,
    newBatchId: () => bid("batch-new"),
  });
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("batch-1") });
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
  await expect(handlers.enqueue({
    ops: [{ op: "delete", uid: uid("uid_x2") }], batchId: bid("batch-x2"),
  })).resolves.toEqual({ pending: 3, batchId: "batch-x2" });
});

test("diagnostics reports counts, meta and integrity results even over a broken FTS index", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({ openDb: async () => t.db });
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  // What a corrupt replica looks like: the FTS index no longer agrees with
  // its content table (here, the only row's index entry is removed).
  t.db.exec("INSERT INTO blocks_fts(blocks_fts, rowid, text)" +
            " SELECT 'delete', rowid, text FROM blocks");

  const report = await handlers.diagnostics(undefined) as ReplicaDiagnostics;

  expect(report.sqliteVersion).toMatch(/^3\./);
  expect(report.quickCheck).toEqual(["ok"]);
  expect(report.counts).toEqual({
    pages: 1, blocks: 1, pending_ops: 0,
    pages_fts_docsize: 1, blocks_fts_docsize: 0,
  });
  expect(report.meta).toEqual({
    cursor: "5", generation: "gen-1", schema_version: SCHEMA_VERSION,
  });
  expect(report.integrity.pages_fts).toBe("ok");
  expect(report.integrity.blocks_fts).not.toBe("ok");
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
    newBatchId: () => bid("batch-local"),
    newRecoveryToken: () => "lease-rebase",
  });
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await handlers.enqueue({
    ops: [{ op: "update_text", uid: uid("uid_b1"), text: "local pending" }],
    batchId: bid("batch-local"),
  });
  const lease = await handlers.prepareRecovery(undefined) as { token: string };

  await expect(handlers.commitRecovery({
    token: lease.token,
    input: {
      kind: "rebase",
      snapshot: {
        ...SNAP,
        blocks: [{ ...SNAP.blocks[0], text: "server authoritative" }],
      },
      acked: [],
    },
  })).resolves.toBeNull();

  expect(t.db.select("SELECT text FROM blocks WHERE uid='uid_b1'"))
    .toEqual([{ text: "local pending" }]);
  expect(t.db.select("SELECT batch_id FROM pending_ops"))
    .toEqual([{ batch_id: "batch-local" }]);
  await expect(handlers.commitRecovery({
    token: lease.token,
    input: { kind: "rebase", snapshot: SNAP, acked: [] },
  })).rejects.toThrow("invalid or inactive recovery token");
});

test("a reset commit rolls back schema rebuild when snapshot application fails", async () => {
  const t = await openRawTestDb();
  let failSnapshot = false;
  const handlers = buildHandlers({
    openDb: async () => t.db,
    nowMs: () => 10,
    newBatchId: () => bid("batch-retained"),
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
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("batch-retained") });
  await handlers.markPoisoned({ id: pid(1), error: "rejected", batchId: bid("batch-retained") });
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
    ops: [{ op: "delete", uid: "uid_b1",
            base_subtree_hash: subtreeHash([["uid_b1", "hello"]]) }],
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
    newBatchId: () => bid("batch-error"),
  });
  await handlers.init(undefined);
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_error") }], batchId: bid("batch-error") });
  await handlers.markPoisoned({ id: pid(1), error: "first rejection", batchId: bid("batch-error") });
  const lease = await handlers.prepareRecovery(undefined) as {
    token: string;
    batches: unknown[];
  };
  expect(lease.batches[0]).not.toHaveProperty("error");

  t.db.exec("UPDATE pending_ops SET error = ? WHERE id = 1", ["changed only error"]);

  await expect(handlers.commitRecovery({
    token: lease.token,
    input: { kind: "rebase", snapshot: SNAP, acked: [] },
  })).rejects.toThrow("pending rows changed during recovery");
});

test("markPoisoned validates batch identity and remains idempotent", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({
    openDb: async () => t.db,
    newBatchId: () => bid("replacement-batch"),
  });
  await handlers.init(undefined);
  await handlers.enqueue({
    ops: [{ op: "delete", uid: uid("uid_new") }], batchId: bid("replacement-batch"),
  });

  await expect(handlers.markPoisoned({
    id: pid(1), batchId: bid("deleted-batch"), error: "old rejection",
  })).resolves.toEqual({ pending: 1, matched: false });
  await expect(handlers.pendingBatches(undefined)).resolves.toEqual([
    expect.objectContaining({
      id: 1, batch_id: "replacement-batch", poisoned: false,
    }),
  ]);

  await expect(handlers.markPoisoned({
    id: pid(1), batchId: bid("replacement-batch"), error: "current rejection",
  })).resolves.toEqual({ pending: 0, matched: true });
  await expect(handlers.markPoisoned({
    id: pid(1), batchId: bid("replacement-batch"), error: "same rejection retry",
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
      newBatchId: () => bid("batch-after-expiry"),
    });
    await handlers.init(undefined);
    const lease = await handlers.prepareRecovery({ expiresAtMs: 100 }) as {
      token: string;
    };
    const later = handlers.enqueue({
      ops: [{ op: "delete", uid: uid("uid_later") }], batchId: bid("batch-after-expiry"),
    });

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
  // SyncProvider lifts the op queue's recovery barrier on
  // the strength of init() rejecting with the latched ReplicaUnusableError,
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
  // This holds because db() is `dbPromise ??= openDb()` and nothing clears
  // the rejection.
  //
  // commitRecovery(), abortRecovery() and close() are deliberately excluded:
  // commitRecovery takes a lease token and is covered by its own recovery
  // tests; abortRecovery and close() never call db() at all on this path
  // (abortRecovery only touches the in-memory recovery gate, and close()
  // only clears dbPromise and calls the injected closeDb). prepareRecovery
  // takes no required payload (its own tests call it with undefined) and
  // does call db(), so it belongs in the list below. init() is just another
  // handler, not one that catches the open failure and returns
  // { ok: false }, so it belongs in the list too.
  let opens = 0;
  const handlers = buildHandlers({
    openDb: async () => {
      opens += 1;
      throw new Error("OPFS is not available in this browser");
    },
  });

  const calls: Array<[string, unknown]> = [
    ["init", undefined],
    ["enqueue", { ops: [{ op: "delete", uid: "uid_b1" }], batchId: "batch-b1" }],
    ["nextBatch", undefined],
    ["deleteBatch", { id: 1, batchId: "b" }],
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
  // This loop calls every method generically by name, so it goes through
  // handlers the same type-erased way serveRpc's own dispatch does -- the
  // point here is uniform behaviour across the whole surface, not any one
  // method's payload shape.
  const dispatch = handlers as unknown as Record<string, (payload: unknown) => Promise<unknown>>;
  for (const [method, payload] of calls) {
    await expect(dispatch[method](payload), method).rejects.toThrow(/OPFS is not available/);
  }
  expect(opens).toBe(1);
});

test("the latched unusable error is one typed object, and close() is its only reset",
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
  expect(first).toBeInstanceOf(ReplicaUnusableError);
  // The original message is preserved deliberately: it is the only
  // diagnostic a user-visible banner has. Retention matches on a type
  // check against this class, never on the message text.
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
  // completing first.
  await expect(handlers.init(undefined)).resolves.toMatchObject({ empty: true });
  await expect(handlers.pendingCount(undefined)).resolves.toBe(0);
  expect(opens).toBe(2);
});

test("init rejects with the latched error instead of reporting ok:false", async () => {
  // An ok:false value would say what the latched rejection already says,
  // kept in sync only by convention. With the worker owning the fact,
  // init() is just another handler.
  const handlers = buildHandlers({
    openDb: async () => { throw new Error("OPFS is not available in this browser"); },
  });
  const err = await handlers.init(undefined).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReplicaUnusableError);
  expect(availabilityOf(err)).toBe("unusable");
});

test("enqueue persists a caller-provided batch id instead of minting one", async () => {
  // The lost-reply window: if the caller never sees this reply, it
  // retains the ops under the id it chose. The row must carry that same id so
  // the duplicate delivery lands on the server's replay path, not a 400.
  const t = await openRawTestDb();
  const handlers = buildHandlers({
    openDb: async () => t.db,
    nowMs: () => 10,
    newBatchId: () => bid("batch-minted"),
  });
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await expect(handlers.enqueue({
    ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("caller-id"),
  })).resolves.toEqual({ pending: 1, batchId: "caller-id" });
  expect(t.db.select("SELECT batch_id FROM pending_ops"))
    .toEqual([{ batch_id: "caller-id" }]);
});

test("a schema rebuild forgets acked seqs, since pending_ops ids restart", async () => {
  // An acked seq is keyed by row id, and ids are only unique within
  // one pending_ops table. Dropping the table resets AUTOINCREMENT, so a seq
  // recorded before a rebuild must not vouch for a new row that reuses its id.
  const t = await openRawTestDb();
  const handlers = buildHandlers({ openDb: async () => t.db, nowMs: () => 10 });
  const ids = () => t.db.select<{ id: number }>("SELECT id FROM pending_ops")
    .map((row) => row.id);
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("a") });
  const [first] = ids();
  await handlers.deleteBatch({ id: pid(first), batchId: bid("a"), ackedSeq: seq(6) });
  await handlers.reset(undefined);
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("b") });
  expect(ids()).toEqual([first]); // the id really is reused
  // the new row vanishes without an ack (an out-of-band removal)
  t.db.exec("DELETE FROM pending_ops");
  await expect(handlers.applyChanges({
    feed: { reset: false, generation: "gen-1",
      plain_space_title_canonicalization: false, next_since: seq(6), latest_seq: seq(6),
      pages: [], blocks: [], sidebar: [], tombstones: [] },
    expectedPendingIds: [pid(first)],
  })).resolves.toEqual({ status: "pending-changed" });
});

test("a reset over a damaged file replaces the file and rebuilds into the new one", async () => {
  const damaged = await openRawTestDb();
  const fresh = await openRawTestDb();
  let current = withDamagedFreelist(damaged.db);
  const discardDbFile = vi.fn(() => { current = fresh.db; });
  const handlers = buildHandlers({
    openDb: async () => current, discardDbFile, nowMs: () => 10,
  });
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("a") });
  const lease = await handlers.prepareRecovery(undefined) as {
    token: string; batches: unknown[];
  };
  expect(lease.batches).toHaveLength(1);

  await expect(handlers.commitRecovery({
    token: lease.token, input: { kind: "reset", snapshot: SNAP },
  })).resolves.toBeNull();

  expect(discardDbFile).toHaveBeenCalledOnce();
  expect(fresh.db.select("SELECT uid, text FROM blocks"))
    .toEqual([{ uid: "uid_b1", text: "hello" }]);
  await expect(handlers.pendingBatches(undefined)).resolves.toEqual([]);
  await expect(handlers.enqueue({
    ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("b"),
  })).resolves.toEqual({ pending: 1, batchId: "b" });
});

test("the no-pending reset replaces a damaged file too", async () => {
  const damaged = await openRawTestDb();
  const fresh = await openRawTestDb();
  let current = withDamagedFreelist(damaged.db);
  const discardDbFile = vi.fn(() => { current = fresh.db; });
  const handlers = buildHandlers({ openDb: async () => current, discardDbFile });
  await handlers.init(undefined);

  await expect(handlers.reset(undefined)).resolves.toBeNull();
  expect(discardDbFile).toHaveBeenCalledOnce();
  expect(fresh.db.select(
    "SELECT name FROM sqlite_master WHERE name = 'pending_ops'"))
    .toEqual([{ name: "pending_ops" }]);
});

test("a reset failure that is not corruption keeps the file", async () => {
  const t = await openRawTestDb();
  const discardDbFile = vi.fn();
  const handlers = buildHandlers({
    openDb: async () => t.db, discardDbFile, nowMs: () => 10,
    applySnapshot: () => { throw new Error("snapshot apply failed"); },
  });
  await handlers.init(undefined);
  const lease = await handlers.prepareRecovery(undefined) as { token: string };
  await expect(handlers.commitRecovery({
    token: lease.token, input: { kind: "reset", snapshot: SNAP },
  })).rejects.toThrow("snapshot apply failed");
  expect(discardDbFile).not.toHaveBeenCalled();
});

const SQLITE_FULL = "SQLITE_FULL: sqlite3 result code 13: database or disk is full";
const DURABLE_ROWS =
  "SELECT id, batch_id, ops_json, poisoned, error FROM pending_ops ORDER BY id";

/** A poisoned batch and a valid one queued behind it, in a replica file that
 * turns out damaged when the repair's rebase runs. Discarding the file really
 * closes the old database, so the rows survive only if they were made
 * durable elsewhere first. `fresh` wraps the new file's database (once, so a
 * failing wrapper fails once per worker); `openAfterDiscard` may be replaced
 * to make the new file's open fail or hang. */
async function poisonedQueueOverDamagedFile(options: {
  fresh?: (db: ReplicaDb) => ReplicaDb;
  carry?: (files: ReturnType<typeof fakeCarryFiles>) => CarryStore | undefined;
  applySnapshot?: WorkerDeps["applySnapshot"];
} = {}) {
  const damaged = await openRawTestDb();
  const fresh = await openRawTestDb();
  const carryFiles = fakeCarryFiles(await openRawTestDb());
  const carry = options.carry
    ? options.carry(carryFiles) : createCarryStore(carryFiles);
  const freshDb = options.fresh ? options.fresh(fresh.db) : fresh.db;
  let isDamaged = false;
  let discarded = false;
  const damagedDb = withDamagedFreelist(damaged.db, /^DELETE /i, () => isDamaged);
  const files = { openAfterDiscard: async (): Promise<ReplicaDb> => freshDb };
  // what the carry held when the old file was unlinked
  let carriedAtDiscard: DurablePendingRow[] | null = null;
  const discardDbFile = vi.fn(() => {
    carriedAtDiscard = carry?.read() ?? null;
    damaged.close();
    discarded = true;
  });
  const handlers = buildHandlers({
    openDb: async () => discarded ? files.openAfterDiscard() : damagedDb,
    discardDbFile, carry, nowMs: () => 10,
    applySnapshot: options.applySnapshot,
  });
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await handlers.enqueue({
    ops: [{ op: "move", uid: uid("uid_gone"), parent_uid: uid("uid_b1"), order_idx: ord(1) }],
    batchId: bid("rejected"),
  });
  await handlers.enqueue({
    ops: [{ op: "update_text", uid: uid("uid_b1"), text: "edited" }],
    batchId: bid("valid"),
  });
  await handlers.markPoisoned({ id: pid(1), error: "HTTP 400", batchId: bid("rejected") });
  const rowsBefore = damaged.db.select<DurablePendingRow>(DURABLE_ROWS);
  isDamaged = true;
  const lease = await handlers.prepareRecovery(undefined) as { token: string };
  const commit = (acked: AckedBatch[] = []) => handlers.commitRecovery({
    token: lease.token, input: { kind: "rebase", snapshot: SNAP, acked },
  });
  return {
    handlers, commit, rowsBefore, carry, carryFiles, discardDbFile,
    damaged, fresh, files, carriedAtDiscard: () => carriedAtDiscard,
  };
}

test("a rebase over a damaged file carries every durable row into a new file", async () => {
  // The rejected-batch repair is a rebase and must never drop the valid rows
  // queued behind the poisoned one: they move across verbatim.
  const { handlers, commit, rowsBefore, carry, discardDbFile, fresh,
          carriedAtDiscard } = await poisonedQueueOverDamagedFile();

  await expect(commit()).resolves.toBeNull();

  expect(discardDbFile).toHaveBeenCalledOnce();
  expect(carriedAtDiscard()).toEqual(rowsBefore);
  expect(fresh.db.select(DURABLE_ROWS)).toEqual(rowsBefore);
  expect(carry?.exists()).toBe(false);
  // snapshot applied, and the valid batch re-applied over it
  expect(fresh.db.select("SELECT uid, text FROM blocks"))
    .toEqual([{ uid: "uid_b1", text: "edited" }]);
  // the provider's post-repair delete by row id still finds the poisoned row
  await expect(handlers.deleteBatch({ id: pid(1), batchId: bid("rejected") })).resolves.toMatchObject({ pending: 1 });
  await expect(handlers.enqueue({
    ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("next"),
  })).resolves.toEqual({ pending: 2, batchId: "next" });
});

test("a rebase keeps the carried rows even if the snapshot then fails on the new file", async () => {
  const damaged = await openRawTestDb();
  const fresh = await openRawTestDb();
  const carry = createCarryStore(fakeCarryFiles(await openRawTestDb()));
  let isDamaged = false;
  let current = withDamagedFreelist(damaged.db, /^DELETE /i, () => isDamaged);
  let failSnapshot = false;
  const handlers = buildHandlers({
    openDb: async () => current,
    discardDbFile: () => { damaged.close(); current = fresh.db; },
    carry,
    nowMs: () => 10,
    applySnapshot: (db, snapshot, nowMs) => {
      if (failSnapshot && db === fresh.db) throw new Error("snapshot apply failed");
      applySnapshot(db, snapshot, nowMs);
    },
  });
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("kept") });
  isDamaged = true;
  failSnapshot = true;
  const lease = await handlers.prepareRecovery(undefined) as { token: string };
  await expect(handlers.commitRecovery({
    token: lease.token, input: { kind: "rebase", snapshot: SNAP, acked: [] },
  })).rejects.toThrow();
  expect(fresh.db.select("SELECT batch_id FROM pending_ops"))
    .toEqual([{ batch_id: "kept" }]);
  expect(carry.exists()).toBe(false);
});

test("a rebase whose new file will not open leaves every row in the carry", async () => {
  const { commit, rowsBefore, carry, files } = await poisonedQueueOverDamagedFile();
  files.openAfterDiscard = () => Promise.reject(new Error("open failed"));
  await expect(commit()).rejects.toThrow("open failed");
  expect(carry?.read()).toEqual(rowsBefore);
});

test("a rebase whose schema install fails on the new file leaves every row in the carry", async () => {
  const { commit, rowsBefore, carry } = await poisonedQueueOverDamagedFile({
    fresh: (db) => failingOnce(db, /CREATE TABLE/i, SQLITE_FULL),
  });
  await expect(commit()).rejects.toThrow(/SQLITE_FULL/);
  expect(carry?.read()).toEqual(rowsBefore);
});

test("a rebase whose row import fails leaves every row in the carry", async () => {
  const { commit, rowsBefore, carry } = await poisonedQueueOverDamagedFile({
    fresh: (db) => failingOnce(db, /^INSERT OR IGNORE INTO pending_ops/, SQLITE_FULL),
  });
  await expect(commit()).rejects.toThrow(/SQLITE_FULL/);
  expect(carry?.read()).toEqual(rowsBefore);
});

test("a carry write failure leaves the damaged file and its rows in place", async () => {
  const { commit, rowsBefore, discardDbFile, damaged } =
    await poisonedQueueOverDamagedFile({
      carry: (inner) => createCarryStore({
        exists: () => inner.exists(),
        unlink: () => { inner.unlink(); },
        open: () => {
          const handle = inner.open();
          return {
            db: failingOnce(handle.db, /^INSERT OR IGNORE/, SQLITE_FULL),
            close: handle.close,
          };
        },
      }),
    });
  await expect(commit()).rejects.toThrow(/SQLITE_FULL/);
  expect(discardDbFile).not.toHaveBeenCalled();
  expect(damaged.db.select(DURABLE_ROWS)).toEqual(rowsBefore);
});

test("a rebase without a carry store keeps the damaged file", async () => {
  const { commit, rowsBefore, discardDbFile, damaged } =
    await poisonedQueueOverDamagedFile({ carry: () => undefined });
  await expect(commit()).rejects.toThrow(/SQLITE_CORRUPT/);
  expect(discardDbFile).not.toHaveBeenCalled();
  expect(damaged.db.select(DURABLE_ROWS)).toEqual(rowsBefore);
});

test("a snapshot failure after the import leaves no carry to resurrect drained rows", async () => {
  // The carry goes as soon as the new file holds the rows. Kept past a failed
  // snapshot, it would be adopted on the next open and bring back rows that
  // were acked or deleted in the meantime.
  let failOn: ReplicaDb | null = null;
  const setup = await poisonedQueueOverDamagedFile({
    applySnapshot: (db, snapshot, nowMs) => {
      if (db === failOn) throw new Error("snapshot apply failed");
      applySnapshot(db, snapshot, nowMs);
    },
  });
  const { handlers, commit, carry, fresh } = setup;
  failOn = fresh.db;
  await expect(commit()).rejects.toThrow("snapshot apply failed");
  expect(fresh.db.select<{ id: number }>(DURABLE_ROWS).map((row) => row.id))
    .toEqual([1, 2]);
  expect(carry?.exists()).toBe(false);
  await handlers.deleteBatch({ id: pid(1), batchId: bid("rejected") });
  await handlers.close(undefined);
  const init = await handlers.init(undefined) as { pendingBatches: { id: number }[] };
  expect(init.pendingBatches.map((batch) => batch.id)).toEqual([2]);
});

const pendingSummary = (batches: unknown) =>
  (batches as { id: number; batch_id: string; poisoned: boolean }[])
    .map(({ id, batch_id, poisoned }) => ({ id, batch_id, poisoned }));

/** A worker that got as far as unlinking the damaged file and then never
 * came back: the new file's open hangs, as it does when the page is
 * suspended mid-repair. */
async function workerDiedAfterDiscard() {
  const setup = await poisonedQueueOverDamagedFile();
  setup.files.openAfterDiscard = () => new Promise<ReplicaDb>(() => {});
  void setup.commit();
  await vi.waitFor(() => { expect(setup.discardDbFile).toHaveBeenCalled(); });
  const next = buildHandlers({
    openDb: async () => setup.fresh.db, carry: setup.carry, nowMs: () => 10,
  });
  return { ...setup, next };
}

test("a worker that dies between discard and import hands its rows to the next worker", async () => {
  const { next, fresh, rowsBefore, carry } = await workerDiedAfterDiscard();
  const init = await next.init(undefined) as { pendingBatches: unknown };
  expect(pendingSummary(init.pendingBatches)).toEqual([
    { id: 1, batch_id: "rejected", poisoned: true },
    { id: 2, batch_id: "valid", poisoned: false },
  ]);
  const poisoned = await next.poisonedBatches(undefined) as
    { id: number; batch_id: string }[];
  expect(poisoned).toHaveLength(1);
  expect(poisoned[0]).toMatchObject({ id: 1, batch_id: "rejected" });
  expect(fresh.db.select(DURABLE_ROWS)).toEqual(rowsBefore);
  expect(carry?.exists()).toBe(false);
});

test("an enqueue served before init on a restarted worker keeps the carried ids", async () => {
  const { next, fresh } = await workerDiedAfterDiscard();
  await next.enqueue({ ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("first-edit") });
  expect(fresh.db.select("SELECT id, batch_id FROM pending_ops ORDER BY id")).toEqual([
    { id: 1, batch_id: "rejected" },
    { id: 2, batch_id: "valid" },
    { id: 3, batch_id: "first-edit" },
  ]);
});

test("a failed open leaves the carry for the open after close", async () => {
  const { handlers, commit, files, fresh } = await poisonedQueueOverDamagedFile();
  files.openAfterDiscard = () => Promise.reject(new Error("open failed"));
  await expect(commit()).rejects.toThrow("open failed");
  files.openAfterDiscard = async () => fresh.db;
  await handlers.close(undefined);
  const init = await handlers.init(undefined) as { pendingBatches: { id: number }[] };
  expect(init.pendingBatches.map((batch) => batch.id)).toEqual([1, 2]);
});

test("a Retry in the same worker rebases the carried rows", async () => {
  const { handlers, commit, rowsBefore, fresh, carry } =
    await poisonedQueueOverDamagedFile({
      fresh: (db) => failingOnce(db, /^INSERT OR IGNORE INTO pending_ops/, SQLITE_FULL),
    });
  await expect(commit()).rejects.toThrow(/SQLITE_FULL/);
  const lease = await handlers.prepareRecovery(undefined) as {
    token: string; batches: readonly { id: number }[];
  };
  expect(lease.batches.map((batch) => batch.id)).toEqual([1, 2]);
  await expect(handlers.commitRecovery({
    token: lease.token, input: { kind: "rebase", snapshot: SNAP, acked: [] },
  })).resolves.toBeNull();
  expect(fresh.db.select(DURABLE_ROWS)).toEqual(rowsBefore);
  expect(carry?.exists()).toBe(false);
});

test("a deleteBatch served first by a restarted worker adopts the carry", async () => {
  const { next, fresh } = await workerDiedAfterDiscard();
  await expect(next.deleteBatch({ id: pid(1), batchId: bid("rejected") })).resolves.toEqual({ pending: 1 });
  expect(fresh.db.select("SELECT id, batch_id FROM pending_ops ORDER BY id"))
    .toEqual([{ id: 2, batch_id: "valid" }]);
});

test("a nextBatch served first by a restarted worker drains the carried rows", async () => {
  const { next } = await workerDiedAfterDiscard();
  await expect(next.nextBatch(undefined))
    .resolves.toMatchObject({ id: 2, batch_id: "valid" });
});

test("a local-API write served first by a restarted worker keeps the carried ids", async () => {
  const { next, fresh } = await workerDiedAfterDiscard();
  await expect(next.localApi({
    method: "POST", path: "/api/pages", body: { title: "Offline" }, nowMs: 1,
  })).resolves.toMatchObject({ handled: true, status: 200 });
  expect(fresh.db.select<{ id: number }>("SELECT id FROM pending_ops ORDER BY id")
    .map((row) => row.id)).toEqual([1, 2, 3]);
});

const SQLITE_CORRUPT =
  "SQLITE_CORRUPT: sqlite3 result code 11: database disk image is malformed";
const SQLITE_NOTADB =
  "SQLITE_NOTADB: sqlite3 result code 26: file is not a database";
const IMPORT_ROW = /^INSERT OR IGNORE INTO pending_ops/;
const CARRIED: DurablePendingRow[] = [
  { id: (1 as PendingRowId), batch_id: bid("rejected"), ops_json: "[]", poisoned: 1, error: "HTTP 400" },
  { id: (2 as PendingRowId), batch_id: bid("valid"), ops_json: "[]", poisoned: 0, error: null },
];

/** A committed carry beside a replica file that cannot take its rows, as a
 * new file damaged in storage cannot. `raw` leaves the
 * replica without a schema, so the adoption's schema install is what runs
 * first; `replacement` opens the file that replaces it. */
async function carryBesideUnwritableReplica(options: {
  failing: RegExp;
  raw?: boolean;
  replacement?: (fresh: ReplicaDb) => Promise<ReplicaDb>;
}) {
  const replica = options.raw ? await openRawTestDb() : await openTestDb();
  const fresh = await openRawTestDb();
  const carry = createCarryStore(fakeCarryFiles(await openRawTestDb()));
  carry.write(CARRIED);
  let replaced = false;
  const discardDbFile = vi.fn(() => { replica.close(); replaced = true; });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const handlers = buildHandlers({
    openDb: async () => replaced
      ? (options.replacement ?? (async (db) => db))(fresh.db)
      : failingOnce(replica.db, options.failing, SQLITE_CORRUPT),
    discardDbFile, carry, nowMs: () => 10,
  });
  return { handlers, carry, fresh, discardDbFile, warn };
}

test.each([
  ["schema install", /CREATE TABLE/i, true],
  ["row import", IMPORT_ROW, false],
])("an adoption whose %s fails replaces the replica file and keeps every carried row",
async (_step, failing, raw) => {
  const { handlers, carry, fresh, discardDbFile, warn } =
    await carryBesideUnwritableReplica({ failing, raw });
  const batches = await handlers.pendingBatches(undefined);
  expect(pendingSummary(batches)).toEqual([
    { id: 1, batch_id: "rejected", poisoned: true },
    { id: 2, batch_id: "valid", poisoned: false },
  ]);
  expect(discardDbFile).toHaveBeenCalledOnce();
  expect(fresh.db.select(DURABLE_ROWS)).toEqual(CARRIED);
  expect(carry.exists()).toBe(false);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

test.each([
  ["will not open", async (): Promise<ReplicaDb> => {
    throw new Error("open failed");
  }, /open failed/],
  ["cannot take the rows either", async (db: ReplicaDb) =>
    failingOnce(db, IMPORT_ROW, SQLITE_FULL), /SQLITE_FULL/],
])("an adoption whose replacement file %s fails loudly and keeps the carry",
async (_how, replacement, expected) => {
  const { handlers, carry, discardDbFile, warn } =
    await carryBesideUnwritableReplica({ failing: IMPORT_ROW, replacement });
  await expect(handlers.pendingBatches(undefined)).rejects.toThrow(expected);
  expect(discardDbFile).toHaveBeenCalledOnce();
  expect(carry.exists()).toBe(true);
  expect(carry.read()).toEqual(CARRIED);
  warn.mockRestore();
});

/** A carry store whose file is present but whose read throws `message`. */
const unreadableCarry = (message: string) => {
  let present = true;
  return {
    exists: () => present,
    write: vi.fn(),
    read: vi.fn((): DurablePendingRow[] => { throw new Error(message); }),
    discard: vi.fn(() => { present = false; }),
  };
};

test.each([SQLITE_NOTADB, SQLITE_CORRUPT])(
  "a torn carry beside an intact replica is discarded and the replica's rows kept: %s",
  async (message) => {
    const t = await openRawTestDb();
    const carry = unreadableCarry(message);
    let carryLeft = false;
    const handlers = buildHandlers({
      openDb: async () => t.db,
      carry: { ...carry, exists: () => carryLeft && carry.exists() },
      nowMs: () => 10,
    });
    await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("kept") });
    carryLeft = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(handlers.pendingCount(undefined)).resolves.toBe(1);
    expect(carry.discard).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(t.db.select("SELECT batch_id FROM pending_ops"))
      .toEqual([{ batch_id: "kept" }]);
  });

test.each([
  "SQLITE_BUSY: sqlite3 result code 5: database is locked",
  "SQLITE_IOERR: sqlite3 result code 10: disk I/O error",
])("a carry that cannot be read for any other reason is kept and the handler fails: %s",
async (message) => {
  const t = await openTestDb();
  const carry = unreadableCarry(message);
  const handlers = buildHandlers({ openDb: async () => t.db, carry });
  await expect(handlers.pendingCount(undefined)).rejects.toThrow(message);
  expect(carry.discard).not.toHaveBeenCalled();
});

test("diagnostics neither adopts a carry nor fails on one", async () => {
  const t = await openTestDb();
  const carry = unreadableCarry("SQLITE_BUSY: sqlite3 result code 5: database is locked");
  const handlers = buildHandlers({ openDb: async () => t.db, carry });
  const report = await handlers.diagnostics(undefined) as ReplicaDiagnostics;
  expect(report.quickCheck).toEqual(["ok"]);
  expect(carry.read).not.toHaveBeenCalled();
  expect(carry.discard).not.toHaveBeenCalled();
});

const SQLITE_IOERR = "SQLITE_IOERR: sqlite3 result code 10: disk I/O error";

/** `db`, except that once `arm()` is called its next `reads` reads of
 * sqlite_master throw `message`. */
function failingSchemaReads(db: ReplicaDb, message: string) {
  let left = 0;
  return {
    arm: (reads = 1) => { left = reads; },
    db: {
      ...db,
      select<T>(sql: string, params?: Parameters<ReplicaDb["select"]>[1]): T[] {
        if (left > 0 && /sqlite_master/.test(sql)) {
          left -= 1;
          throw new Error(message);
        }
        return db.select<T>(sql, params);
      },
      transaction: (fn: () => void) => db.transaction(fn),
    } as ReplicaDb,
  };
}

/** A replica holding batches `one` and `two` beside a carry file: empty, as
 * a carry write that failed after opening its file leaves one, or holding
 * `carried`. Once set up, the replica's next `reads` schema reads fail. */
async function replicaBesideEmptyCarry(
  message: string, reads: number, carried?: DurablePendingRow[],
) {
  const replica = await openRawTestDb();
  const fresh = await openRawTestDb();
  const carryFiles = fakeCarryFiles(await openRawTestDb());
  const carry = createCarryStore(carryFiles);
  const failing = failingSchemaReads(replica.db, message);
  let replaced = false;
  const handlers = buildHandlers({
    openDb: async () => replaced ? fresh.db : failing.db,
    discardDbFile: () => { replica.close(); replaced = true; },
    carry, nowMs: () => 10,
  });
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("one") });
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b2") }], batchId: bid("two") });
  if (carried) carry.write(carried);
  else carryFiles.open().close();
  failing.arm(reads);
  return { handlers, carry, fresh, replaced: () => replaced };
}

test("a replacement at adoption keeps the rows the replica still held beside an empty carry",
async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { handlers, carry, fresh, replaced } =
    await replicaBesideEmptyCarry(SQLITE_IOERR, 1);
  const batches = await handlers.pendingBatches(undefined) as { batch_id: string }[];
  expect(replaced()).toBe(true);
  expect(batches.map((batch) => batch.batch_id)).toEqual(["one", "two"]);
  expect(fresh.db.select<{ id: number }>("SELECT id FROM pending_ops ORDER BY id")
    .map((row) => row.id)).toEqual([1, 2]);
  expect(carry.exists()).toBe(false);
  warn.mockRestore();
});

test("a replacement at adoption over a replica it cannot read imports the carry's rows",
async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { handlers, carry, fresh, replaced } =
    await replicaBesideEmptyCarry(SQLITE_IOERR, Infinity, CARRIED);
  await handlers.pendingBatches(undefined);
  expect(replaced()).toBe(true);
  expect(fresh.db.select(DURABLE_ROWS)).toEqual(CARRIED);
  expect(carry.exists()).toBe(false);
  warn.mockRestore();
});

test("a failed carry write leaves no carry behind", async () => {
  const { commit, carryFiles } = await poisonedQueueOverDamagedFile({
    carry: (inner) => createCarryStore({
      exists: () => inner.exists(),
      unlink: () => { inner.unlink(); },
      open: () => {
        const handle = inner.open();
        return {
          db: failingOnce(handle.db, /^INSERT OR IGNORE/, SQLITE_FULL),
          close: handle.close,
        };
      },
    }),
  });
  await expect(commit()).rejects.toThrow(/SQLITE_FULL/);
  expect(carryFiles.exists()).toBe(false);
});

test("a replacement that fails after the old file is discarded keeps the union in the carry",
async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const replica = await openRawTestDb();
  const fresh = await openRawTestDb();
  const carryFiles = fakeCarryFiles(await openRawTestDb());
  const carry = createCarryStore(carryFiles);
  const failing = failingSchemaReads(replica.db, SQLITE_IOERR);
  let replaced = false;
  const handlers = buildHandlers({
    openDb: async () => replaced
      ? failingOnce(fresh.db, IMPORT_ROW, SQLITE_FULL)
      : failing.db,
    discardDbFile: () => { replica.close(); replaced = true; },
    carry, nowMs: () => 10,
  });
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("one") });
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b2") }], batchId: bid("two") });
  // an empty carry, present but never written
  carryFiles.open().close();
  failing.arm(1);

  // the retry's own import (into the new file) fails, after the old file
  // holding "one" and "two" is already gone
  await expect(handlers.pendingBatches(undefined)).rejects.toThrow(/SQLITE_FULL/);

  // the merged rows must have reached the carry before the old file was
  // discarded, or they are lost for good
  expect(carry.exists()).toBe(true);
  expect(carry.read().map((row) => row.batch_id)).toEqual(["one", "two"]);
  warn.mockRestore();
});


const TWO: Snapshot = {
  ...SNAP,
  blocks: [SNAP.blocks[0],
           { ...SNAP.blocks[0], uid: uid("uid_b2"), order_idx: ord(1), text: "b2" }],
};
const SERVER: Snapshot = {
  ...TWO, seq: (7 as SyncSeq),
  blocks: [{ ...TWO.blocks[0], text: "[[New]] edited" },
           { ...TWO.blocks[1], text: "server b2" }],
};
const EMPTY_GEN1_FEED: Changes = {
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: seq(7), latest_seq: seq(7), pages: [], blocks: [], sidebar: [], tombstones: [],
};
const textOf = (db: ReplicaDb, uid: string): unknown =>
  db.select<{ text: string }>("SELECT text FROM blocks WHERE uid = ?", [uid])[0]?.text;
const pendingIds = (db: ReplicaDb): unknown =>
  db.select("SELECT batch_id FROM pending_ops ORDER BY id");

/** Row 1 ("acked") is a batch the recovery flush got an ack for, which the
 * server saved differently from its wire text; row 2 ("open") is one the
 * flush did not reach. */
async function leasedAckedAndOpen(
  options: { applySnapshot?: WorkerDeps["applySnapshot"] } = {},
) {
  const t = await openRawTestDb();
  const handlers = buildHandlers({
    openDb: async () => t.db, nowMs: () => 10,
    applySnapshot: options.applySnapshot,
  });
  await handlers.init(undefined);
  await handlers.applySnapshot(TWO);
  await handlers.enqueue({
    ops: [{ op: "update_text", uid: uid("uid_b1"), text: "[[Old]] edited" }],
    batchId: bid("acked"),
  });
  await handlers.enqueue({
    ops: [{ op: "update_text", uid: uid("uid_b2"), text: "local pending" }],
    batchId: bid("open"),
  });
  const lease = await handlers.prepareRecovery(undefined) as { token: string };
  const commit = (acked: AckedBatch[], snapshot: Snapshot = SERVER) => handlers.commitRecovery({
    token: lease.token, input: { kind: "rebase", snapshot, acked },
  });
  return { t, handlers, commit };
}

test("a rebase commit deletes the acked rows and replays only the rest", async () => {
  const { t, commit } = await leasedAckedAndOpen();
  await expect(commit([{ id: (1 as PendingRowId), batch_id: bid("acked"), seq: (7 as SyncSeq) }])).resolves.toBeNull();
  expect(textOf(t.db, "uid_b1")).toBe("[[New]] edited");
  expect(textOf(t.db, "uid_b2")).toBe("local pending");
  expect(pendingIds(t.db)).toEqual([{ batch_id: "open" }]);
});

test("a rebase commit records an acked row's seq as deleteBatch does", async () => {
  const { handlers, commit } = await leasedAckedAndOpen();
  await commit([{ id: (1 as PendingRowId), batch_id: bid("acked"), seq: (7 as SyncSeq) }]);
  await expect(handlers.applyChanges({
    feed: EMPTY_GEN1_FEED, expectedPendingIds: [pid(1), pid(2)],
  })).resolves.toEqual({ status: "applied", cursor: 7 });
});

test("an acked row without a seq vouches for no window", async () => {
  const { handlers, commit } = await leasedAckedAndOpen();
  await commit([{ id: (1 as PendingRowId), batch_id: bid("acked"), seq: null }]);
  await expect(handlers.applyChanges({
    feed: EMPTY_GEN1_FEED, expectedPendingIds: [pid(1), pid(2)],
  })).resolves.toEqual({ status: "pending-changed" });
});

test("an ack that matches no row by id and batch id deletes nothing", async () => {
  const { t, commit } = await leasedAckedAndOpen();
  await expect(commit([
    { id: (1 as PendingRowId), batch_id: bid("open"), seq: (7 as SyncSeq) }, { id: (9 as PendingRowId), batch_id: bid("acked"), seq: (7 as SyncSeq) },
  ])).resolves.toBeNull();
  expect(pendingIds(t.db)).toEqual([{ batch_id: "acked" }, { batch_id: "open" }]);
  expect(textOf(t.db, "uid_b1")).toBe("[[Old]] edited");
});

test("a rebase commit whose snapshot fails keeps the acked rows", async () => {
  let failSnapshot = false;
  const { t, commit } = await leasedAckedAndOpen({
    applySnapshot: (db, snapshot, nowMs) => {
      if (failSnapshot) throw new Error("snapshot apply failed");
      applySnapshot(db, snapshot, nowMs);
    },
  });
  failSnapshot = true;
  await expect(commit([{ id: (1 as PendingRowId), batch_id: bid("acked"), seq: (7 as SyncSeq) }]))
    .rejects.toThrow("snapshot apply failed");
  expect(pendingIds(t.db)).toEqual([{ batch_id: "acked" }, { batch_id: "open" }]);
});

test("a commit with acked rows still refuses changed durable rows and deletes nothing", async () => {
  const { t, commit } = await leasedAckedAndOpen();
  // an external writer bypassing the gate
  t.db.exec(
    "INSERT INTO pending_ops(batch_id, ops_json) VALUES (?, ?)",
    ["bypassed", JSON.stringify([{ op: "delete", uid: "uid_x1" }])],
  );
  await expect(commit([{ id: (1 as PendingRowId), batch_id: bid("acked"), seq: (7 as SyncSeq) }]))
    .rejects.toThrow("pending rows changed during recovery");
  expect(t.db.select("SELECT id FROM pending_ops WHERE id = 1")).toEqual([{ id: 1 }]);
});

test("a rebase that replaces the file carries only the rows no ack covers", async () => {
  const { handlers, commit, rowsBefore, carry, fresh, carriedAtDiscard } =
    await poisonedQueueOverDamagedFile();
  await expect(commit([{ id: (2 as PendingRowId), batch_id: bid("valid"), seq: (7 as SyncSeq) }])).resolves.toBeNull();
  expect(carriedAtDiscard()).toEqual([rowsBefore[0]]);
  expect(fresh.db.select(DURABLE_ROWS)).toEqual([rowsBefore[0]]);
  // the snapshot's text, with the acked edit not replayed over it
  expect(textOf(fresh.db, "uid_b1")).toBe("hello");
  expect(carry?.exists()).toBe(false);
  await handlers.close(undefined);
  await handlers.init(undefined);
  expect((await handlers.pendingBatches(undefined) as { id: number }[])
    .map((batch) => batch.id)).toEqual([1]);
});

/** The drain holds row 1 ("x") with its POST in flight when a recovery
 * leases. The user types behind the lease, and the drain's delete for "x"
 * queues behind that. The commit then restarts the queue's ids (a file
 * replacement carries no acked row; a reset drops the table), so "typed"
 * takes id 1, and a delete by bare id would remove a never-sent edit. */
async function drainDeleteQueuedBehindLease(options: { damaged: boolean }) {
  const damaged = await openRawTestDb();
  const fresh = await openRawTestDb();
  const carry = createCarryStore(fakeCarryFiles(await openRawTestDb()));
  let isDamaged = false;
  let discarded = false;
  const damagedDb = withDamagedFreelist(damaged.db, /^DELETE /i, () => isDamaged);
  const handlers = buildHandlers({
    openDb: async () => discarded ? fresh.db : damagedDb,
    discardDbFile: () => { damaged.close(); discarded = true; },
    carry, nowMs: () => 10,
  });
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await handlers.enqueue({
    ops: [{ op: "update_text", uid: uid("uid_b1"), text: "sent" }], batchId: bid("x"),
  });
  await expect(handlers.nextBatch(undefined)).resolves.toMatchObject({ id: 1 });
  isDamaged = options.damaged;
  const lease = await handlers.prepareRecovery(undefined) as { token: string };
  const typed = handlers.enqueue({
    ops: [{ op: "update_text", uid: uid("uid_b1"), text: "typed" }], batchId: bid("typed"),
  });
  const drainDelete = handlers.deleteBatch({ id: pid(1), batchId: bid("x"), ackedSeq: seq(7) });
  const db = () => discarded ? fresh.db : damaged.db;
  return { handlers, lease, typed, drainDelete, db, discarded: () => discarded };
}

test("the drain's delete for a batch a replacing rebase settled spares the batch that reuses its id", async () => {
  const { handlers, lease, typed, drainDelete, db, discarded } =
    await drainDeleteQueuedBehindLease({ damaged: true });
  await expect(handlers.commitRecovery({
    token: lease.token,
    input: { kind: "rebase", snapshot: SNAP, acked: [{ id: pid(1), batch_id: bid("x"), seq: seq(7) }] },
  })).resolves.toBeNull();
  await expect(typed).resolves.toMatchObject({ batchId: "typed" });
  await drainDelete;
  expect(discarded()).toBe(true);
  expect(db().select("SELECT id, batch_id FROM pending_ops"))
    .toEqual([{ id: 1, batch_id: "typed" }]);
});

test("the drain's delete for a batch a reset dropped spares the batch that reuses its id", async () => {
  const { handlers, lease, typed, drainDelete, db } =
    await drainDeleteQueuedBehindLease({ damaged: false });
  await expect(handlers.commitRecovery({
    token: lease.token, input: { kind: "reset", snapshot: SNAP },
  })).resolves.toBeNull();
  await expect(typed).resolves.toMatchObject({ batchId: "typed" });
  await drainDelete;
  expect(db().select("SELECT id, batch_id FROM pending_ops"))
    .toEqual([{ id: 1, batch_id: "typed" }]);
});

test("a delete that matches no row records no acked seq for its id", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({ openDb: async () => t.db, nowMs: () => 10 });
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("a") });
  // a stale delete for another batch that once held id 1
  await handlers.deleteBatch({ id: pid(1), batchId: bid("gone"), ackedSeq: seq(7) });
  expect(t.db.select("SELECT batch_id FROM pending_ops")).toEqual([{ batch_id: "a" }]);
  // Row 1 is later deleted without an ack, so nothing may vouch for it.
  t.db.exec("DELETE FROM pending_ops WHERE id = 1");
  await expect(handlers.applyChanges({
    feed: EMPTY_GEN1_FEED, expectedPendingIds: [pid(1)],
  })).resolves.toEqual({ status: "pending-changed" });
});

test("deleteBatch refuses a payload without the row's batch id", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({ openDb: async () => t.db, nowMs: () => 10 });
  await handlers.init(undefined);
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b1") }], batchId: bid("a") });
  // Both calls below hand deleteBatch a payload that doesn't match
  // ReplicaRpc's shape at all -- exactly the malformed, pre-type-system
  // input its own runtime check (not the type system) still has to catch.
  await expect(handlers.deleteBatch(
    { id: pid(1) } as unknown as Parameters<typeof handlers.deleteBatch>[0],
  )).rejects.toThrow(/batch id/);
  await expect(handlers.deleteBatch(
    1 as unknown as Parameters<typeof handlers.deleteBatch>[0],
  )).rejects.toThrow(/batch id/);
  expect(t.db.select("SELECT batch_id FROM pending_ops")).toEqual([{ batch_id: "a" }]);
});

const named = (batchId: string, at: number, skipped: Changes["applied_batches"] = []) =>
  ({ batch_id: bid(batchId), seq: seq(at), skipped: skipped as never[] });

/** Two queued batches over SNAP: row 1 "a", row 2 "b". */
async function twoQueued() {
  const t = await openRawTestDb();
  const handlers = buildHandlers({ openDb: async () => t.db, nowMs: () => 10 });
  await handlers.init(undefined);
  await handlers.applySnapshot(SNAP);
  await handlers.enqueue({
    ops: [{ op: "update_text", uid: uid("uid_b1"), text: "a" }], batchId: bid("a") });
  await handlers.enqueue({
    ops: [{ op: "update_text", uid: uid("uid_b1"), text: "b" }], batchId: bid("b") });
  return { t, handlers };
}

test("applyChanges drops the rows its window names as applied and returns them", async () => {
  const { t, handlers } = await twoQueued();
  await expect(handlers.applyChanges({
    feed: { ...EMPTY_GEN1_FEED, applied_batches: [named("a", 7)] },
    expectedPendingIds: [pid(1), pid(2)],
  })).resolves.toEqual({
    status: "applied", cursor: 7,
    dropped: [{ id: pid(1), batch_id: bid("a"), seq: seq(7), skipped: [] }],
  });
  expect(pendingIds(t.db)).toEqual([{ batch_id: "b" }]);
});

test("a dropped row's acked seq vouches for a window as a drain ack's does", async () => {
  const { handlers } = await twoQueued();
  await handlers.applyChanges({
    feed: { ...EMPTY_GEN1_FEED, applied_batches: [named("a", 7)] },
    expectedPendingIds: [pid(1), pid(2)],
  });
  // a pull that read its pending ids before the drop
  await expect(handlers.applyChanges({
    feed: EMPTY_GEN1_FEED, expectedPendingIds: [pid(1), pid(2)],
  })).resolves.toEqual({ status: "applied", cursor: 7 });
});

test("a later deleteBatch for a dropped row is a harmless no-op", async () => {
  const { t, handlers } = await twoQueued();
  await handlers.applyChanges({
    feed: { ...EMPTY_GEN1_FEED, applied_batches: [named("a", 7)] },
    expectedPendingIds: [pid(1), pid(2)],
  });
  await expect(handlers.deleteBatch({ id: pid(1), batchId: bid("a"), ackedSeq: seq(7) }))
    .resolves.toEqual({ pending: 1 });
  expect(pendingIds(t.db)).toEqual([{ batch_id: "b" }]);
});

test("a row queued after the pull read its ids is never dropped", async () => {
  const { t, handlers } = await twoQueued();
  // the pull read rows 1 and 2; row 3 arrives while its fetch is out
  await handlers.enqueue({
    ops: [{ op: "update_text", uid: uid("uid_b1"), text: "c" }], batchId: bid("c") });
  await expect(handlers.applyChanges({
    feed: { ...EMPTY_GEN1_FEED, applied_batches: [named("a", 7), named("c", 7)] },
    expectedPendingIds: [pid(1), pid(2)],
  })).resolves.toEqual({ status: "pending-changed" });
  expect(pendingIds(t.db)).toEqual([{ batch_id: "a" }, { batch_id: "b" }, { batch_id: "c" }]);
});

test("applySnapshot drops the rows the snapshot names as applied", async () => {
  const { t, handlers } = await twoQueued();
  await handlers.applySnapshot({ ...SNAP, seq: seq(7), applied_batches: [named("a", 7)] });
  expect(pendingIds(t.db)).toEqual([{ batch_id: "b" }]);
  expect(textOf(t.db, "uid_b1")).toBe("b");
  await expect(handlers.applyChanges({
    feed: EMPTY_GEN1_FEED, expectedPendingIds: [pid(1), pid(2)],
  })).resolves.toEqual({ status: "applied", cursor: 7 });
});

test("a rebase commit drops the rows its snapshot names beside the acked ones", async () => {
  const { t, handlers, commit } = await leasedAckedAndOpen();
  await expect(commit(
    [{ id: pid(1), batch_id: bid("acked"), seq: seq(7) }],
    { ...SERVER, applied_batches: [named("open", 7)] },
  )).resolves.toBeNull();
  expect(pendingIds(t.db)).toEqual([]);
  expect(textOf(t.db, "uid_b2")).toBe("server b2");
  await expect(handlers.applyChanges({
    feed: EMPTY_GEN1_FEED, expectedPendingIds: [pid(1), pid(2)],
  })).resolves.toEqual({ status: "applied", cursor: 7 });
});

const shiftingCreate = (id: string) => ({
  ops: [{ op: "create" as const, uid: uid("uid_new"), page_title: "AI",
          parent_uid: null, order_idx: ord(0), text: "new" }],
  batchId: bid(id),
});
const orderOf = (db: ReplicaDb, u: string): unknown =>
  db.select<{ order_idx: number }>("SELECT order_idx FROM blocks WHERE uid = ?", [u])[0]?.order_idx;

test("an enqueue on a file without effect_ledger creates it, records, and leaves schema_version stale", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({ openDb: async () => t.db, nowMs: () => 10 });
  await handlers.init(undefined);
  await handlers.applySnapshot(TWO);
  t.db.exec("DROP TABLE effect_ledger");
  t.db.exec("INSERT OR REPLACE INTO sync_client_meta(key, value) VALUES ('schema_version', 'old')");
  await handlers.enqueue(shiftingCreate("a"));
  expect(t.db.select("SELECT uid FROM effect_ledger WHERE batch_id = 'a' ORDER BY uid"))
    .toEqual([{ uid: "uid_b1" }, { uid: "uid_b2" }]);
  expect(t.db.select("SELECT value FROM sync_client_meta WHERE key = 'schema_version'"))
    .toEqual([{ value: "old" }]);
});

test("an enqueue on a file whose effect_ledger lacks row_json adds the column, records the cascade, and leaves schema_version stale", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({ openDb: async () => t.db, nowMs: () => 10 });
  await handlers.init(undefined);
  await handlers.applySnapshot({
    ...TWO,
    blocks: [...TWO.blocks, { ...TWO.blocks[0], uid: uid("uid_c"),
                              parent_uid: uid("uid_b2"), order_idx: ord(0), text: "c" }],
  });
  t.db.exec("DROP TABLE effect_ledger");
  t.db.exec(`CREATE TABLE effect_ledger(
    batch_id        TEXT NOT NULL,
    uid             TEXT NOT NULL,
    order_delta     INTEGER NOT NULL DEFAULT 0,
    base_page_id    INTEGER,
    base_updated_at INTEGER,
    PRIMARY KEY (batch_id, uid)
  ) WITHOUT ROWID`);
  t.db.exec("INSERT OR REPLACE INTO sync_client_meta(key, value) VALUES ('schema_version', 'old')");
  await handlers.enqueue({ ops: [{ op: "delete", uid: uid("uid_b2") }], batchId: bid("a") });
  expect(t.db.select("SELECT uid FROM effect_ledger WHERE row_json IS NOT NULL"))
    .toEqual([{ uid: "uid_c" }]);
  expect(t.db.select("SELECT uid FROM blocks WHERE uid IN ('uid_b2', 'uid_c')")).toEqual([]);
  expect(t.db.select("SELECT value FROM sync_client_meta WHERE key = 'schema_version'"))
    .toEqual([{ value: "old" }]);
});

test("deleteBatch without a seq, then a head window, reverts", async () => {
  const t = await openRawTestDb();
  const handlers = buildHandlers({ openDb: async () => t.db, nowMs: () => 10 });
  await handlers.init(undefined);
  await handlers.applySnapshot(TWO);
  await handlers.enqueue(shiftingCreate("a"));
  expect(orderOf(t.db, "uid_b2")).toBe(2);
  await handlers.deleteBatch({ id: pid(1), batchId: bid("a") });
  await expect(handlers.applyChanges({ feed: EMPTY_GEN1_FEED, expectedPendingIds: [] }))
    .resolves.toMatchObject({ status: "applied" });
  expect(orderOf(t.db, "uid_b2")).toBe(1);
});
