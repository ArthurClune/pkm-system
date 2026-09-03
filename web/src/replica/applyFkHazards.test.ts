// @vitest-environment node
// FK hazards in feed/snapshot application (pkm-qvlx). defer_foreign_keys=ON
// postpones FK checks to the outer COMMIT — past the savepoints reapplyPending
// relies on. A dangling parent_uid therefore doesn't fail the op that inserts
// it; it fails the whole window/snapshot transaction, and because the cursor
// never advances, every retry refetches the same window: sync is wedged with
// "FOREIGN KEY constraint failed", and reset/repair (which re-run
// reapplyPending) wedge the same way.
import { beforeEach, describe, expect, test } from "vitest";
import type { Changes, Snapshot, SyncBlock } from "./apply";
import { applyChanges, applySnapshot } from "./apply";
import type { ReplicaDb } from "./db";
import { getMeta } from "./meta";
import { enqueueBatch, markPoisoned, nextBatch } from "./queue";
import { openTestDb, type TestDb } from "./testDb";

const block = (uid: string, pageId: number, over: Partial<SyncBlock> = {}): SyncBlock => ({
  uid, page_id: pageId, parent_uid: null, order_idx: 0, text: `text of ${uid}`,
  heading: null, view_type: null, collapsed: 0, created_at: 1, updated_at: 1,
  refs: [], ...over,
});

const page = (id: number, title: string) =>
  ({ id, title, created_at: 1, updated_at: 1 });

const SNAP: Snapshot = {
  generation: "gen-1", plain_space_title_canonicalization: false, seq: 10,
  pages: [page(1, "Machine Learning"), page(2, "AI")],
  blocks: [
    block("uid_b1", 1),
    block("uid_b2", 1, { order_idx: 1 }),
    block("uid_b3", 1, { parent_uid: "uid_b2" }),
  ],
  sidebar: [],
};

const emptyFeed = (over: Partial<Changes> = {}): Changes => ({
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: 10, latest_seq: 10,
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

// Two tests below fail a COMMIT on purpose, so the run carries sqlite-wasm's
// own "sqlite3_step() rc= 787 ... SQL = COMMIT" line on stderr. It cannot be
// spied away (the engine binds its warn sink at module init) and is expected
// output, not a stray error — apply.test.ts already logs the same for a
// deliberate primary-key conflict.

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
    const res = applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 20,
      blocks: [block("uid_child", 1, { parent_uid: "uid_future_parent" })],
    }));
    expect(res).toEqual({ status: "needs-bootstrap" });
    // the failed COMMIT must leave the replica exactly as it was: a partially
    // applied window with an advanced cursor would silently lose the rest
    expect(getMeta(t.db, "cursor")).toBe("10");
    expect(uids(t.db)).toEqual(["uid_b1", "uid_b2", "uid_b3"]);
  });

  test("a pending create under a block the feed tombstones does not wedge the window", () => {
    // Train scenario: an agent (CLI/MCP) deletes uid_b2 server-side while
    // this client has a queued create under it. The tombstone cascades the
    // optimistic child away, then reapplyPending re-creates it under the
    // now-missing parent — a dangling insert the savepoint does NOT catch
    // under deferred FKs.
    enqueueBatch(t.db, [
      { op: "create", uid: "uid_child", page_title: "Machine Learning",
        parent_uid: "uid_b2", order_idx: 0, text: "typed offline" },
    ], 5, "batch-child");
    const res = applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      tombstones: [{ kind: "block", entity_id: "uid_b2" }],
    }));
    expect(res).toEqual({ status: "applied", cursor: 11 });
    expect(getMeta(t.db, "cursor")).toBe("11");
    // the unappliable batch is skipped locally, not deleted — push-time
    // resolution still owns it
    expect(uids(t.db)).toEqual(["uid_b1"]);
    expect(queuedBatchIds(t.db)).toEqual(["batch-child"]);
  });

  test("a pending child of a poisoned batch's block does not wedge snapshot repair", () => {
    // Poison repair and Reset local data both re-run reapplyPending over a
    // fresh snapshot. The poisoned batch (which created the parent) is
    // rightly skipped; the later batch's child must not leave a dangling
    // parent_uid that fails the snapshot COMMIT — that makes repair/reset
    // churn forever.
    enqueueBatch(t.db, [
      { op: "create", uid: "uid_opt_parent", page_title: "AI",
        parent_uid: null, order_idx: 0, text: "rejected parent" },
    ], 5, "batch-parent");
    const rejected = nextBatch(t.db)!;
    markPoisoned(t.db, rejected.id, JSON.stringify({
      status: 400, message: "request failed: 400 /api/ops",
    }), "batch-parent");
    enqueueBatch(t.db, [
      { op: "create", uid: "uid_opt_child", page_title: "AI",
        parent_uid: "uid_opt_parent", order_idx: 0, text: "child" },
    ], 6, "batch-child");
    // a batch that still applies cleanly must survive the skip of the one
    // before it: skipping is per-batch, not a bail-out of the whole reapply
    enqueueBatch(t.db, [
      { op: "create", uid: "uid_opt_ok", page_title: "AI",
        parent_uid: null, order_idx: 1, text: "still valid" },
    ], 6, "batch-ok");
    applySnapshot(t.db, SNAP, 7);
    expect(uids(t.db))
      .toEqual(["uid_b1", "uid_b2", "uid_b3", "uid_opt_ok"]);
    expect(queuedBatchIds(t.db))
      .toEqual(["batch-parent", "batch-child", "batch-ok"]);
  });

  test("the reset rebuild's foreign_keys=OFF does not let a dangling batch through", () => {
    // rebuildSchema (Reset local data) disables FK enforcement around the
    // whole drop/reinstall/snapshot transaction, so nothing would fail the
    // COMMIT — a dangling reapplied batch would just be written and stay
    // there. The guard reads PRAGMA foreign_key_check, which ignores the
    // enforcement pragmas, so it still catches it.
    enqueueBatch(t.db, [
      { op: "create", uid: "uid_opt_child", page_title: "AI",
        parent_uid: "uid_never_existed", order_idx: 0, text: "child" },
    ], 5, "batch-child");
    t.db.exec("PRAGMA foreign_keys=OFF");
    try {
      applySnapshot(t.db, SNAP, 7);
    } finally {
      t.db.exec("PRAGMA foreign_keys=ON");
    }
    expect(t.db.select("PRAGMA foreign_key_check")).toEqual([]);
    expect(uids(t.db)).toEqual(["uid_b1", "uid_b2", "uid_b3"]);
    expect(queuedBatchIds(t.db)).toEqual(["batch-child"]);
  });

  test("a window failing on anything other than an FK still throws", () => {
    // needs-bootstrap is the answer to a dependency-incomplete window (and,
    // since pkm-n31j, to a stale title holder) only. Any other constraint
    // failure is a genuine bug or a corrupt replica, and bootstrapping past
    // it would hide it behind an endless resync.
    expect(() => applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      pages: [page(3, null as unknown as string)], // pages.title is NOT NULL
    }))).toThrow(/NOT NULL constraint failed/);
    expect(getMeta(t.db, "cursor")).toBe("10");
  });

  test("a snapshot that dangles on its own still throws", () => {
    // Unlike a window, a snapshot carries the whole graph. A dangling row in
    // one is not a windowing artefact to rebootstrap past — it means the feed
    // is wrong, and swallowing it would loop bootstrap forever.
    expect(() => applySnapshot(t.db, {
      ...SNAP, seq: 12,
      blocks: [...SNAP.blocks, block("uid_orphan", 1, { parent_uid: "uid_gone" })],
    })).toThrow(/FOREIGN KEY constraint failed/);
    expect(getMeta(t.db, "cursor")).toBe("10");
  });
});
