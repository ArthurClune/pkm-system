// @vitest-environment node
// FK hazards in feed/snapshot application. defer_foreign_keys=ON
// postpones FK checks to the outer COMMIT — past the savepoints replayPending
// relies on. A dangling parent_uid therefore doesn't fail the op that inserts
// it; it fails the whole window/snapshot transaction, and because the cursor
// never advances, every retry refetches the same window: sync is wedged with
// "FOREIGN KEY constraint failed", and reset/repair (which re-run
// replayPending) wedge the same way.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BatchId, BlockUid, CanonicalTitle, PageId, SyncSeq } from "../api/brands";
import type { Changes, Snapshot, SyncBlock } from "./apply";
import { applyChanges, applySnapshot } from "./apply";
import type { ReplicaDb } from "./db";
import { getMeta } from "./meta";
import { deleteBatch, enqueueBatch, markPoisoned, nextBatch } from "./queue";

// Every test here picks an arbitrary batch-id string, same shape as the
// production mint; this mints the brand once rather than at every call.
const bid = (s: string): BatchId => s as BatchId;
import { openTestDb, type TestDb } from "./testDb";
import { ord, uid } from "../test-helpers";

/** The drain's delete of the batch at the head of the queue, on its ack. */
const ackNext = (db: ReplicaDb): void => {
  const b = nextBatch(db)!;
  deleteBatch(db, b.id, b.batch_id);
};

const block = (rawUid: string, rawPageId: number, over: Partial<SyncBlock> = {}): SyncBlock => ({
  uid: rawUid as BlockUid, page_id: rawPageId as PageId, parent_uid: null, order_idx: ord(0),
  text: `text of ${rawUid}`,
  heading: null, view_type: null, collapsed: 0, created_at: 1, updated_at: 1,
  refs: [], ...over,
});

const page = (rawId: number, rawTitle: string) =>
  ({ id: rawId as PageId, title: rawTitle as CanonicalTitle, created_at: 1, updated_at: 1 });

const SNAP: Snapshot = {
  generation: "gen-1", plain_space_title_canonicalization: false, seq: (10 as SyncSeq),
  pages: [page(1, "Machine Learning"), page(2, "AI")],
  blocks: [
    block("uid_b1", 1),
    block("uid_b2", 1, { order_idx: ord(1) }),
    block("uid_b3", 1, { parent_uid: uid("uid_b2") }),
  ],
  sidebar: [],
};

const emptyFeed = (over: Partial<Changes> = {}): Changes => ({
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: (10 as SyncSeq), latest_seq: (10 as SyncSeq),
  pages: [], blocks: [], sidebar: [], tombstones: [], ...over,
});

const uids = (db: ReplicaDb): string[] =>
  db.select<{ uid: string }>("SELECT uid FROM blocks ORDER BY uid")
    .map((r) => r.uid);

/** Batch ids still queued, poisoned rows included: the queue is the user's
 * intent, so nothing on this path may delete one. */
const queuedBatchIds = (db: ReplicaDb): string[] =>
  db.select<{ batch_id: string }>(
    "SELECT batch_id FROM pending_ops ORDER BY id").map((r) => r.batch_id);

// Tests that fail a COMMIT or a statement on purpose spy on console.warn and
// assert what the engine and applyChanges log; the engine's own
// "sqlite3_step() rc= ..." lines reach console.warn through testDb.ts.
const quietWarn = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);
afterEach(() => { vi.restoreAllMocks(); });

let t: TestDb;
beforeEach(async () => {
  t?.close();
  t = await openTestDb();
  applySnapshot(t.db, SNAP);
});

describe("feed windows and pending batches must not wedge on FK constraints", () => {
  test("a window whose parent rows never arrived asks for a bootstrap", () => {
    // Degraded-network catch-up: the client is > window-limit rows behind, and
    // hydration is current-state, so a window can carry a block whose
    // parent_uid's own creation row lies beyond the window. The server now
    // completes such windows with the parent blocks they depend on
    // (test_sync_window_parents.py) — this is the client's fallback for a
    // server that doesn't, and it must degrade to a rebootstrap rather than
    // refetch the same unappliable window forever.
    const warn = quietWarn();
    const res = applyChanges(t.db, emptyFeed({
      next_since: (11 as SyncSeq), latest_seq: (20 as SyncSeq),
      blocks: [block("uid_child", 1, { parent_uid: uid("uid_future_parent") })],
    }));
    expect(res).toEqual({ status: "needs-bootstrap" });
    expect(warn).toHaveBeenCalledWith(
      "sqlite3_step() rc=", 787, "SQLITE_CONSTRAINT_FOREIGNKEY", "SQL =", "COMMIT");
    expect(warn).toHaveBeenCalledWith(
      "applyChanges: window failed its deferred FK check, rebootstrapping",
      expect.anything());
    // the failed COMMIT must leave the replica exactly as it was: a partially
    // applied window with an advanced cursor would silently lose the rest
    expect(getMeta(t.db, "cursor")).toBe("10");
    expect(uids(t.db)).toEqual(["uid_b1", "uid_b2", "uid_b3"]);
  });

  test("a pending create under a block the feed tombstones does not wedge the window", () => {
    // Train scenario: an agent (CLI/MCP) deletes uid_b2 server-side while
    // this client has a queued create under it. The window rewinds the
    // optimistic child and the tombstone takes the parent, then the replay
    // must not re-create the child under the now-missing parent — a
    // dangling insert the savepoint does NOT catch under deferred FKs.
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_child"), page_title: "Machine Learning",
        parent_uid: uid("uid_b2"), order_idx: ord(0), text: "typed offline" },
    ], 5, bid("batch-child"));
    const res = applyChanges(t.db, emptyFeed({
      next_since: (11 as SyncSeq), latest_seq: (11 as SyncSeq),
      tombstones: [{ kind: "block", entity_id: "uid_b2" }],
    }));
    expect(res).toEqual({ status: "applied", cursor: 11 });
    expect(getMeta(t.db, "cursor")).toBe("11");
    // the unappliable batch is skipped locally, not deleted — push-time
    // resolution still owns it
    expect(uids(t.db)).toEqual(["uid_b1"]);
    expect(queuedBatchIds(t.db)).toEqual([bid("batch-child")]);
  });

  test("tombstones the server journals for a skipped op drop a ghost and its local-only child", () => {
    // The server skips an op on a missing target and journals the uids a
    // replica may hold a ghost of. uid_ghost is one: an acked create the
    // server diverted to the daily note, still in the replica because the
    // ack deleted its batch. uid_ghost_child is a queued create under it.
    // uid_never_seen is a journalled uid this replica never had (the
    // missing parent of a diverted create) -- a DELETE that matches no row.
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_ghost"), page_title: "Machine Learning",
        parent_uid: null, order_idx: ord(5), text: "diverted server-side" },
    ], 5, bid("batch-ghost"));
    ackNext(t.db); // the ack
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_ghost_child"), page_title: "Machine Learning",
        parent_uid: uid("uid_ghost"), order_idx: ord(0), text: "typed under it" },
    ], 6, bid("batch-child"));
    expect(uids(t.db)).toContain("uid_ghost_child");
    const res = applyChanges(t.db, emptyFeed({
      next_since: (11 as SyncSeq), latest_seq: (11 as SyncSeq),
      tombstones: [{ kind: "block", entity_id: "uid_ghost" },
                   { kind: "block", entity_id: "uid_never_seen" }],
    }));
    expect(res).toEqual({ status: "applied", cursor: 11 });
    expect(uids(t.db)).toEqual(["uid_b1", "uid_b2", "uid_b3"]);
    // the child's batch is skipped locally, not deleted: its push lands it
    // under the missing parent's daily-note header
    expect(queuedBatchIds(t.db)).toEqual([bid("batch-child")]);
    expect(t.db.select("PRAGMA foreign_key_check")).toEqual([]);
  });

  test("a block moved under a ghost keeps its subtree when the ghost's tombstone and the re-shipped subtree share a window", () => {
    // The client moved uid_b2 (child uid_b3) under uid_ghost_p, a parent the
    // server never had; both batches are acked. The server skips the move
    // and journals the parent's tombstone first, then every row of the moved
    // subtree. The tombstone cascades uid_b2 and uid_b3 away locally; the
    // upserts that follow must bring both back at their real position.
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_ghost_p"), page_title: "Machine Learning",
        parent_uid: null, order_idx: ord(5), text: "ghost parent" },
    ], 5, bid("batch-ghost-p"));
    ackNext(t.db);
    enqueueBatch(t.db, [
      { op: "move", uid: uid("uid_b2"), parent_uid: uid("uid_ghost_p"), order_idx: ord(0) },
    ], 6, bid("batch-move"));
    ackNext(t.db);
    const res = applyChanges(t.db, emptyFeed({
      next_since: (11 as SyncSeq), latest_seq: (11 as SyncSeq),
      tombstones: [{ kind: "block", entity_id: "uid_ghost_p" }],
      blocks: [block("uid_b2", 1, { order_idx: ord(1) }),
               block("uid_b3", 1, { parent_uid: uid("uid_b2") })],
    }));
    expect(res).toEqual({ status: "applied", cursor: 11 });
    expect(t.db.select("SELECT uid, parent_uid FROM blocks ORDER BY uid"))
      .toEqual([{ uid: "uid_b1", parent_uid: null },
                { uid: "uid_b2", parent_uid: null },
                { uid: "uid_b3", parent_uid: "uid_b2" }]);
  });

  test("a rowid a batch's delete freed does not hide a later batch's dangling insert", () => {
    // `blocks` is a rowid table (uid TEXT PRIMARY KEY, no AUTOINCREMENT): a
    // new row's rowid is max(rowid)+1, so deleting the max-rowid row frees it
    // for reuse by the very next insert. Both rows below dangle on their
    // page, and foreign_key_check keys a row by (table, rowid, parent, fkid),
    // so the insert that reuses the deleted row's rowid reports the identical
    // key. A baseline carried over from before the delete would wave it
    // through; the one taken at the later batch's savepoint does not.
    // FKs off (the reset rebuild) keeps the dangling rows from failing the
    // COMMIT, which is what lets the outcome be read from the rows.
    applySnapshot(t.db, { ...SNAP, blocks: [...SNAP.blocks, block("uid_v", 1)] });
    enqueueBatch(t.db, [{ op: "delete", uid: uid("uid_v") }], 5, bid("batch-del-v"));
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_y"), page_title: "Machine Learning",
        parent_uid: uid("uid_b3"), order_idx: ord(0), text: "typed offline" },
    ], 6, bid("batch-create-y"));
    t.db.exec("PRAGMA foreign_keys=OFF");
    try {
      applySnapshot(t.db, {
        ...SNAP,
        blocks: [block("uid_b1", 1), block("uid_b2", 1, { order_idx: ord(1) }),
                 block("uid_b3", 98, { parent_uid: uid("uid_b2") }), // rowid 3
                 block("uid_v", 99)],                                  // rowid 4
      }, 7);
    } finally {
      t.db.exec("PRAGMA foreign_keys=ON");
    }
    // the delete freed rowid 4; the create under uid_b3 (page 98 is missing)
    // would take it, and must roll back
    expect(uids(t.db)).toEqual(["uid_b1", "uid_b2", "uid_b3"]);
    expect(queuedBatchIds(t.db)).toEqual([bid("batch-del-v"), bid("batch-create-y")]);
    expect(t.db.select("SELECT rowid, page_id FROM blocks WHERE page_id > 90"))
      .toEqual([{ rowid: 3, page_id: 98 }]);
  });

  test("a pending child of a poisoned batch's block does not wedge snapshot repair", () => {
    // Poison repair and Reset local data both re-run replayPending over a
    // fresh snapshot. The poisoned batch (which created the parent) is
    // rightly skipped; the later batch's child must not leave a dangling
    // parent_uid that fails the snapshot COMMIT — that makes repair/reset
    // churn forever.
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_opt_parent"), page_title: "AI",
        parent_uid: null, order_idx: ord(0), text: "rejected parent" },
    ], 5, bid("batch-parent"));
    const rejected = nextBatch(t.db)!;
    markPoisoned(t.db, rejected.id, JSON.stringify({
      status: 400, message: "request failed: 400 /api/ops",
    }), bid("batch-parent"));
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_opt_child"), page_title: "AI",
        parent_uid: uid("uid_opt_parent"), order_idx: ord(0), text: "child" },
    ], 6, bid("batch-child"));
    // a batch that still applies cleanly must survive the skip of the one
    // before it: skipping is per op, not a bail-out of the whole replay
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_opt_ok"), page_title: "AI",
        parent_uid: null, order_idx: ord(1), text: "still valid" },
    ], 6, bid("batch-ok"));
    applySnapshot(t.db, SNAP, 7);
    expect(uids(t.db))
      .toEqual(["uid_b1", "uid_b2", "uid_b3", "uid_opt_ok"]);
    expect(queuedBatchIds(t.db))
      .toEqual([bid("batch-parent"), bid("batch-child"), bid("batch-ok")]);
  });

  // A failing op is skipped alone on replay, as enqueueBatch skips it, where
  // the whole batch used to roll back.
  test("a replayed batch keeps its other ops when one op adds an FK violation", () => {
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_x"), page_title: "Machine Learning",
        parent_uid: uid("uid_b2"), order_idx: ord(1), text: "x" },
      { op: "update_text", uid: uid("uid_b1"), text: "mine" },
    ], 5, bid("batch-x"));
    enqueueBatch(t.db, [
      { op: "move", uid: uid("uid_b2"), parent_uid: null, page_title: "AI",
        order_idx: ord(0) },
    ], 5, bid("batch-move"));

    // uid_b2 arrives on a page the window never ships: the create under it
    // lands there too and dangles, so it alone rolls back; batch-move's
    // replay takes uid_b2 to AI, and the COMMIT holds
    const res = applyChanges(t.db, emptyFeed({
      next_since: (11 as SyncSeq), latest_seq: (11 as SyncSeq),
      blocks: [block("uid_b2", 99)],
    }));

    expect(res).toEqual({ status: "applied", cursor: 11 });
    expect(t.db.select("SELECT uid, page_id, text FROM blocks ORDER BY uid"))
      .toEqual([{ uid: "uid_b1", page_id: 1, text: "mine" },
                { uid: "uid_b2", page_id: 2, text: "text of uid_b2" },
                { uid: "uid_b3", page_id: 2, text: "text of uid_b3" }]);
  });

  test("a window failing on anything other than an FK still throws", () => {
    // needs-bootstrap is the answer to a dependency-incomplete window (and
    // to a stale title holder) only. Any other constraint
    // failure is a genuine bug or a corrupt replica, and bootstrapping past
    // it would hide it behind an endless resync.
    const warn = quietWarn();
    expect(() => applyChanges(t.db, emptyFeed({
      next_since: (11 as SyncSeq), latest_seq: (11 as SyncSeq),
      pages: [page(3, null as unknown as string)], // pages.title is NOT NULL
    }))).toThrow(/NOT NULL constraint failed/);
    expect(warn).toHaveBeenCalledWith(
      "sqlite3_step() rc=", 1299, "SQLITE_CONSTRAINT_NOTNULL", "SQL =",
      expect.stringContaining("INSERT INTO pages"));
    expect(getMeta(t.db, "cursor")).toBe("10");
  });

  test("a snapshot that dangles on its own still throws", () => {
    // Unlike a window, a snapshot carries the whole graph. A dangling row in
    // one is not a windowing artefact to rebootstrap past — it means the feed
    // is wrong, and swallowing it would loop bootstrap forever.
    const warn = quietWarn();
    expect(() => applySnapshot(t.db, {
      ...SNAP, seq: (12 as SyncSeq),
      blocks: [...SNAP.blocks, block("uid_orphan", 1, { parent_uid: uid("uid_gone") })],
    })).toThrow(/FOREIGN KEY constraint failed/);
    expect(warn).toHaveBeenCalledWith(
      "sqlite3_step() rc=", 787, "SQLITE_CONSTRAINT_FOREIGNKEY", "SQL =", "COMMIT");
    expect(getMeta(t.db, "cursor")).toBe("10");
  });

  test("a pending op with a NULL uid under a block on a page the window never ships rolls back", () => {
    // A NULL uid leaves no replay record (the recording is INSERT OR IGNORE
    // into a NOT NULL column), so the page record is the only trace of the
    // block it inserts on the missing page.
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_x"), page_title: "Machine Learning",
        parent_uid: uid("uid_b2"), order_idx: ord(1), text: "x" },
    ], 5, bid("batch-x"));
    // the typed API mints a uid; a crafted or old-build row need not
    const queued = JSON.parse(t.db.select<{ ops_json: string }>(
      "SELECT ops_json FROM pending_ops")[0].ops_json) as Record<string, unknown>[];
    queued[0].uid = null;
    t.db.exec("UPDATE pending_ops SET ops_json = ?", [JSON.stringify(queued)]);
    enqueueBatch(t.db, [
      { op: "move", uid: uid("uid_b2"), parent_uid: null, page_title: "AI",
        order_idx: ord(0) },
    ], 5, bid("batch-move"));
    const res = applyChanges(t.db, emptyFeed({
      next_since: (11 as SyncSeq), latest_seq: (11 as SyncSeq),
      blocks: [block("uid_b2", 99)],
    }));
    expect(res).toEqual({ status: "applied", cursor: 11 });
    expect(t.db.select("SELECT COUNT(*) AS n FROM blocks WHERE uid IS NULL"))
      .toEqual([{ n: 0 }]);
    expect(t.db.select("PRAGMA foreign_key_check")).toEqual([]);
  });
});

// With foreign_keys=OFF (the reset rebuild) nothing cascades, so a replayed
// delete removes the deleted block's refs and block_refs rows itself and the
// delete lands exactly as it does with FKs on. Only a child the subtree match
// misses is left for targetedFkHit's CHILD clause.
describe("a pending delete replayed with foreign_keys=OFF", () => {
  const snapshotWith = (blocks: SyncBlock[]): Snapshot => ({ ...SNAP, blocks });

  const rows = (db: ReplicaDb) => ({
    blocks: uids(db),
    refs: db.select("SELECT src_block_uid, target_page_id, kind FROM refs ORDER BY 1, 2, 3"),
    blockRefs: db.select("SELECT src_block_uid, target_block_uid FROM block_refs ORDER BY 1, 2"),
  });

  const replayDelete = (snap: Snapshot, victim: string, fksOff: boolean): void => {
    applySnapshot(t.db, snap);
    enqueueBatch(t.db, [{ op: "delete", uid: uid(victim) }], 5, bid("batch-del"));
    expect(uids(t.db)).not.toContain(victim);
    if (fksOff) t.db.exec("PRAGMA foreign_keys=OFF");
    try {
      applySnapshot(t.db, snap, 7);
    } finally {
      t.db.exec("PRAGMA foreign_keys=ON");
    }
  };

  /** Replay with FKs off, require the delete to have landed cleanly, and
   * require the FKs-on replay of the same snapshot to leave identical rows. */
  const expectDeleteLands = (snap: Snapshot, victim: string, kept: string[]): void => {
    replayDelete(snap, victim, true);
    expect(uids(t.db)).toEqual(kept);
    expect(queuedBatchIds(t.db)).toEqual([bid("batch-del")]);
    expect(t.db.select("PRAGMA foreign_key_check")).toEqual([]);
    const off = rows(t.db);
    replayDelete(snap, victim, false);
    expect(rows(t.db)).toEqual(off);
  };

  test("a child the delete's subtree match misses (uid containing a comma)", () => {
    replayDelete(snapshotWith([
      block("a,bcdefg", 1),
      block("bcdefg", 1, { parent_uid: uid("a,bcdefg") }),
    ]), "a,bcdefg", true);
    expect(uids(t.db)).toEqual(["a,bcdefg", "bcdefg"]);
    expect(queuedBatchIds(t.db)).toEqual([bid("batch-del")]);
    expect(t.db.select("PRAGMA foreign_key_check")).toEqual([]);
  });

  test("a block with a [[link]] is deleted along with its refs rows", () => {
    expectDeleteLands(snapshotWith([
      block("uid_r1", 1, { text: "see [[AI]]",
        refs: [{ target_page_id: 2 as PageId, kind: "link" }] }),
    ]), "uid_r1", []);
    expect(t.db.select("SELECT * FROM refs")).toEqual([]);
  });

  test("a block with a ((uid)) ref is deleted along with its block_refs rows", () => {
    expectDeleteLands(snapshotWith([
      block("uid_s1", 1, { text: "see ((uid_s2))" }),
      block("uid_s2", 1),
    ]), "uid_s1", ["uid_s2"]);
    expect(t.db.select("SELECT * FROM block_refs")).toEqual([]);
  });
});

describe("the replica schema's foreign keys", () => {
  test("are exactly the ones targetedFkHit's clauses cover", () => {
    // Adding or changing an FK means revisiting targetedFkHit in apply.ts:
    // it checks the rows a replayed batch wrote against these and no others.
    const tables = t.db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    const fks = tables.flatMap(({ name }) => t.db.select<{
      from: string; table: string; to: string; on_delete: string }>(
      `SELECT "from", "table", "to", on_delete FROM pragma_foreign_key_list(?)`,
      [name]).map((f) => `${name}.${f.from} -> ${f.table}.${f.to} ${f.on_delete}`))
      .sort();
    expect(fks, "an FK changed: revisit targetedFkHit in replica/apply.ts").toEqual([
      "block_refs.src_block_uid -> blocks.uid CASCADE",
      "blocks.page_id -> pages.id CASCADE",
      "blocks.parent_uid -> blocks.uid CASCADE",
      "refs.src_block_uid -> blocks.uid CASCADE",
      "refs.target_page_id -> pages.id CASCADE",
      "replay_log_refs.log_id -> replay_log.id CASCADE",
    ]);
  });
});
