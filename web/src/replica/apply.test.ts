// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type { Changes, Snapshot, SyncBlock } from "./apply";
import { applyChanges, applySnapshot } from "./apply";
import { getMeta } from "./meta";
import { allBatches, deleteBatch, enqueueBatch, markPoisoned, nextBatch } from "./queue";
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
    block("uid_b1", 1, { text: "links [[AI]]", refs: [{ target_page_id: 2, kind: "link" }] }),
    block("uid_b2", 1, { order_idx: 1 }),
    block("uid_b3", 1, { parent_uid: "uid_b2", text: "child block searchable" }),
  ],
  sidebar: [{ id: 1, title: "AI", order_idx: 0 }],
};

const emptyFeed = (over: Partial<Changes> = {}): Changes => ({
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: 10, latest_seq: 10,
  pages: [], blocks: [], sidebar: [], tombstones: [], ...over,
});

let t: TestDb;
beforeEach(async () => {
  t?.close();
  t = await openTestDb();
  applySnapshot(t.db, SNAP);
});

const count = (sql: string): number =>
  Number(t.db.select<{ n: number }>(sql)[0].n);

const ftsHits = (term: string): string[] =>
  t.db.select<{ uid: string }>(
    "SELECT b.uid FROM blocks b JOIN blocks_fts f ON f.rowid = b.rowid" +
    " WHERE blocks_fts MATCH ?", [term]).map((r) => r.uid);

describe("applySnapshot", () => {
  test("accepts authoritative page titles with forbidden local-write syntax", () => {
    applySnapshot(t.db, {
      ...SNAP,
      pages: [page(30, "Authoritative #Page")],
      blocks: [],
      sidebar: [{ id: 30, title: "Authoritative #Page", order_idx: 0 }],
    });

    expect(t.db.select("SELECT id, title FROM pages")).toEqual([
      { id: 30, title: "Authoritative #Page" },
    ]);
    expect(t.db.select("SELECT id, title FROM sidebar_entries")).toEqual([
      { id: 30, title: "Authoritative #Page" },
    ]);
  });

  test("populates graph, refs, sidebar, FTS, cursor and generation", () => {
    expect(count("SELECT COUNT(*) AS n FROM pages")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM blocks")).toBe(3);
    expect(t.db.select("SELECT target_page_id, kind FROM refs"))
      .toEqual([{ target_page_id: 2, kind: "link" }]);
    expect(count("SELECT COUNT(*) AS n FROM sidebar_entries")).toBe(1);
    expect(ftsHits("searchable")).toEqual(["uid_b3"]);
    expect(getMeta(t.db, "cursor")).toBe("10");
    expect(getMeta(t.db, "generation")).toBe("gen-1");
  });

  test("stores view metadata from snapshots and change feeds", () => {
    applySnapshot(t.db, {
      ...SNAP,
      blocks: [block("uid_b1", 1, { view_type: "numbered" })],
    });
    expect(t.db.select(
      "SELECT view_type FROM blocks WHERE uid = 'uid_b1'"))
      .toEqual([{ view_type: "numbered" }]);

    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      blocks: [block("uid_b1", 1, { view_type: "document" })],
    }));
    expect(t.db.select(
      "SELECT view_type FROM blocks WHERE uid = 'uid_b1'"))
      .toEqual([{ view_type: "document" }]);
  });

  test("bootstrap re-applies queued optimistic batches over the snapshot", () => {
    // edits race the snapshot fetch: they applied optimistically to the
    // pre-snapshot database and sit in pending_ops. The wipe must not lose
    // that state, or later ops on those blocks throw "block not found".
    enqueueBatch(t.db, [
      { op: "create", uid: "uid_opt", page_title: "Machine Learning",
        parent_uid: null, order_idx: 0, text: "typed during bootstrap" },
    ], 5, "batch-opt");
    applySnapshot(t.db, SNAP, 6);
    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_opt'"))
      .toEqual([{ text: "typed during bootstrap" }]);
    // the batch itself still flushes to the server untouched
    expect(count("SELECT COUNT(*) AS n FROM pending_ops WHERE poisoned = 0"))
      .toBe(1);
  });

  test("a queued batch that no longer applies is skipped, not fatal", () => {
    enqueueBatch(t.db, [
      { op: "create", uid: "uid_keep", page_title: "AI",
        parent_uid: null, order_idx: 0, text: "kept" },
    ], 5, "batch-keep");
    // references a block that exists now but is not in the snapshot and
    // is created by no queued batch: unappliable after the wipe
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text," +
      " heading, collapsed, created_at, updated_at)" +
      " VALUES ('uid_gone_after_wipe', 1, NULL, 9, 'x', NULL, 0, 5, 5)");
    enqueueBatch(t.db, [
      { op: "set_heading", uid: "uid_gone_after_wipe", heading: 1 },
    ], 5, "batch-doomed");
    applySnapshot(t.db, SNAP, 6);
    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_keep'"))
      .toEqual([{ text: "kept" }]);
    expect(count("SELECT COUNT(*) AS n FROM blocks" +
                 " WHERE uid = 'uid_gone_after_wipe'")).toBe(0);
    // snapshot content is intact despite the failed batch
    expect(count("SELECT COUNT(*) AS n FROM blocks WHERE uid = 'uid_b1'"))
      .toBe(1);
  });

  test("repair removes rejected text and structure without losing valid work", () => {
    enqueueBatch(t.db, [
      { op: "update_text", uid: "uid_b1", text: "rejected text" },
      { op: "move", uid: "uid_b2", page_title: "Machine Learning",
        parent_uid: "uid_b1", order_idx: 0 },
    ], 5, "batch-rejected");
    const rejected = nextBatch(t.db)!;
    markPoisoned(t.db, rejected.id, JSON.stringify({
      status: 400, message: "request failed: 400 /api/ops",
    }), "batch-rejected");
    enqueueBatch(t.db, [
      { op: "set_heading", uid: "uid_b3", heading: 2 },
    ], 5, "batch-valid");

    applySnapshot(t.db, SNAP, 6);
    expect(t.db.select(
      "SELECT text FROM blocks WHERE uid = 'uid_b1'"))
      .toEqual([{ text: "links [[AI]]" }]);
    expect(t.db.select(
      "SELECT parent_uid, order_idx FROM blocks WHERE uid = 'uid_b2'"))
      .toEqual([{ parent_uid: null, order_idx: 1 }]);
    expect(t.db.select(
      "SELECT heading FROM blocks WHERE uid = 'uid_b3'"))
      .toEqual([{ heading: 2 }]);

    // Successful repair deletes the poison audit row. A later valid edit of
    // the same block remains optimistic across both feeds and snapshots.
    deleteBatch(t.db, rejected.id);
    enqueueBatch(t.db, [
      { op: "update_text", uid: "uid_b1", text: "later valid text" },
    ], 7, "batch-later-valid");
    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      blocks: [block("uid_b1", 1, { text: "authoritative feed text" })],
    }), 8);
    expect(t.db.select(
      "SELECT text FROM blocks WHERE uid = 'uid_b1'"))
      .toEqual([{ text: "later valid text" }]);
    expect(t.db.select(
      "SELECT parent_uid, order_idx FROM blocks WHERE uid = 'uid_b2'"))
      .toEqual([{ parent_uid: null, order_idx: 1 }]);

    applySnapshot(t.db, SNAP, 9);
    expect(t.db.select(
      "SELECT text FROM blocks WHERE uid = 'uid_b1'"))
      .toEqual([{ text: "later valid text" }]);
    expect(t.db.select(
      "SELECT parent_uid, order_idx FROM blocks WHERE uid = 'uid_b2'"))
      .toEqual([{ parent_uid: null, order_idx: 1 }]);
  });

  test("persists activation before replaying pending ops", () => {
    t.db.exec(
      "INSERT INTO pending_ops(batch_id, ops_json) VALUES (?, ?)",
      ["pending-snapshot-title", JSON.stringify([
        { op: "create_page", page_title: "  Snapshot Pending  " },
      ])],
    );

    applySnapshot(t.db, {
      ...SNAP,
      plain_space_title_canonicalization: true,
    }, 6);

    expect(getMeta(t.db, "plain_space_title_canonicalization")).toBe("1");
    expect(t.db.select("SELECT title FROM pages WHERE title LIKE '%Pending%'"))
      .toEqual([{ title: "Snapshot Pending" }]);
  });

  test("re-bootstrap wipes stale rows first", () => {
    applySnapshot(t.db, {
      generation: "gen-2", plain_space_title_canonicalization: true, seq: 4,
      pages: [page(7, "Fresh")], blocks: [block("uid_new1", 7)],
      sidebar: [],
    });
    expect(t.db.select("SELECT title FROM pages")).toEqual([{ title: "Fresh" }]);
    expect(count("SELECT COUNT(*) AS n FROM blocks")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM sidebar_entries")).toBe(0);
    expect(ftsHits("searchable")).toEqual([]); // FTS wiped with the rows
    expect(getMeta(t.db, "generation")).toBe("gen-2");
    expect(getMeta(t.db, "cursor")).toBe("4");
  });

  test("wipes block_refs before rebuilding", () => {
    t.db.exec("INSERT INTO block_refs VALUES ('uid_b1', 'uid_stale')");

    applySnapshot(t.db, SNAP); // no block refs in any of its texts

    expect(t.db.select("SELECT * FROM block_refs")).toEqual([]);
  });
});

describe("applyChanges", () => {
  test("accepts authoritative feed page titles with forbidden local-write syntax", () => {
    expect(applyChanges(t.db, emptyFeed({
      next_since: 11,
      latest_seq: 11,
      pages: [page(31, "Authoritative [[Feed]]")],
      sidebar: [{ id: 31, title: "Authoritative [[Feed]]", order_idx: 0 }],
    }))).toEqual({ status: "applied", cursor: 11 });

    expect(t.db.select("SELECT id, title FROM pages WHERE id = 31")).toEqual([
      { id: 31, title: "Authoritative [[Feed]]" },
    ]);
    expect(t.db.select("SELECT id, title FROM sidebar_entries WHERE id = 31"))
      .toEqual([{ id: 31, title: "Authoritative [[Feed]]" }]);
  });

  test("activation reconciles already-applied pending page targets before replay", () => {
    enqueueBatch(t.db, [
      { op: "create_page", page_title: "  New Page Target  " },
    ], 5, "pending-create-page");
    enqueueBatch(t.db, [
      { op: "create", uid: "uid_pending1", page_title: "  Created Block Target  ",
        parent_uid: null, order_idx: 0, text: "pending create" },
    ], 5, "pending-create");
    enqueueBatch(t.db, [
      { op: "move", uid: "uid_b2", parent_uid: null, order_idx: 0,
        page_title: "  Moved Block Target  " },
    ], 5, "pending-move");

    expect(t.db.select(
      "SELECT id, title FROM pages WHERE id < 0 ORDER BY title"))
      .toEqual([
        { id: -2, title: "  Created Block Target  " },
        { id: -3, title: "  Moved Block Target  " },
        { id: -1, title: "  New Page Target  " },
      ]);
    expect(t.db.select(
      "SELECT uid, page_id FROM blocks" +
      " WHERE uid IN ('uid_pending1', 'uid_b2', 'uid_b3') ORDER BY uid"))
      .toEqual([
        { uid: "uid_b2", page_id: -3 },
        { uid: "uid_b3", page_id: -3 },
        { uid: "uid_pending1", page_id: -2 },
      ]);
    const wireOpsBefore = allBatches(t.db).map((batch) => batch.ops);
    expect(wireOpsBefore).toEqual([
      [{ op: "create_page", page_title: "  New Page Target  " }],
      [{ op: "create", uid: "uid_pending1", page_title: "  Created Block Target  ",
        parent_uid: null, order_idx: 0, text: "pending create" }],
      [{ op: "move", uid: "uid_b2", parent_uid: null, order_idx: 0,
        page_title: "  Moved Block Target  " }],
    ]);

    expect(applyChanges(t.db, emptyFeed({
      next_since: 11,
      latest_seq: 11,
      plain_space_title_canonicalization: true,
      pages: [
        page(10, "New Page Target"),
        page(11, "Created Block Target"),
        page(12, "Moved Block Target"),
      ],
    }), 6)).toEqual({ status: "applied", cursor: 11 });

    expect(getMeta(t.db, "plain_space_title_canonicalization")).toBe("1");
    expect(t.db.select(
      "SELECT id, title FROM pages WHERE title LIKE '%Target%' ORDER BY id"))
      .toEqual([
        { id: 10, title: "New Page Target" },
        { id: 11, title: "Created Block Target" },
        { id: 12, title: "Moved Block Target" },
      ]);
    expect(t.db.select("SELECT id, title FROM pages WHERE id < 0")).toEqual([]);
    expect(t.db.select(
      "SELECT uid, page_id FROM blocks" +
      " WHERE uid IN ('uid_pending1', 'uid_b2', 'uid_b3') ORDER BY uid"))
      .toEqual([
        { uid: "uid_b2", page_id: 12 },
        { uid: "uid_b3", page_id: 12 },
        { uid: "uid_pending1", page_id: 11 },
      ]);
    expect(allBatches(t.db).map((batch) => batch.ops)).toEqual(wireOpsBefore);
  });

  test("feed windows preserve optimistically-applied pending state", () => {
    // a feed window can deliver a block's OLDER server row while a newer
    // local update_text is still queued; letting the row win would revert
    // the visible text AND poison the next op's base_text_hash into a
    // spurious server-side conflict copy
    enqueueBatch(t.db, [
      { op: "update_text", uid: "uid_b1", text: "local newer text" },
    ], 5, "b-opt");
    applyChanges(t.db, emptyFeed({
      next_since: 12, latest_seq: 12,
      blocks: [block("uid_b1", 1, { text: "older server text" })],
    }), 6);
    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'"))
      .toEqual([{ text: "local newer text" }]);
  });

  test("upserts new page + block with refs and advances the cursor", () => {
    const feed = emptyFeed({
      next_since: 15, latest_seq: 15,
      pages: [page(3, "Paper")],
      blocks: [block("uid_b9", 3, {
        text: "cites [[Machine Learning]]",
        refs: [{ target_page_id: 1, kind: "link" }],
      })],
    });
    expect(applyChanges(t.db, feed)).toEqual({ status: "applied", cursor: 15 });
    expect(ftsHits("cites")).toEqual(["uid_b9"]);
    expect(t.db.select("SELECT target_page_id FROM refs WHERE src_block_uid = 'uid_b9'"))
      .toEqual([{ target_page_id: 1 }]);
    expect(getMeta(t.db, "cursor")).toBe("15");
  });

  test("an edited block replaces its text, FTS entry and refs", () => {
    const feed = emptyFeed({
      next_since: 12, latest_seq: 12,
      blocks: [block("uid_b1", 1, { text: "no more links" })],
    });
    applyChanges(t.db, feed);
    expect(count("SELECT COUNT(*) AS n FROM refs WHERE src_block_uid = 'uid_b1'")).toBe(0);
    expect(ftsHits("links")).toEqual(["uid_b1"]);
    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'"))
      .toEqual([{ text: "no more links" }]);
  });

  test("upsertBlock derives block_refs from synced text", () => {
    // block_refs never ride the feed: the client extracts them from the
    // block's own text on every upsert (pkm-d31f).
    applyChanges(t.db, emptyFeed({
      next_since: 12, latest_seq: 12,
      blocks: [block("uid_b1", 1, { text: "cites ((uid_tgtA))", refs: [] })],
    }));

    expect(t.db.select("SELECT * FROM block_refs")).toEqual([
      { src_block_uid: "uid_b1", target_block_uid: "uid_tgtA" }]);

    applyChanges(t.db, emptyFeed({
      next_since: 13, latest_seq: 13,
      blocks: [block("uid_b1", 1, { text: "cites nothing now", refs: [] })],
    }));

    expect(t.db.select("SELECT * FROM block_refs")).toEqual([]);
  });

  test("re-applying the same window is idempotent", () => {
    const feed = emptyFeed({
      next_since: 12, latest_seq: 12,
      blocks: [block("uid_b1", 1, {
        text: "still [[AI]]", refs: [{ target_page_id: 2, kind: "link" }] })],
    });
    applyChanges(t.db, feed);
    applyChanges(t.db, feed);
    expect(count("SELECT COUNT(*) AS n FROM blocks")).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM refs WHERE src_block_uid = 'uid_b1'")).toBe(1);
  });

  test("a block tombstone cascades to its subtree and FTS", () => {
    const feed = emptyFeed({
      next_since: 13, latest_seq: 13,
      tombstones: [{ kind: "block", entity_id: "uid_b2" }],
    });
    applyChanges(t.db, feed);
    expect(count("SELECT COUNT(*) AS n FROM blocks")).toBe(1); // b2 + child b3 gone
    expect(ftsHits("searchable")).toEqual([]);
  });

  test("a page tombstone cascades to its blocks and refs", () => {
    const feed = emptyFeed({
      next_since: 13, latest_seq: 13,
      tombstones: [{ kind: "page", entity_id: "1" }],
    });
    applyChanges(t.db, feed);
    expect(count("SELECT COUNT(*) AS n FROM blocks")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM refs")).toBe(0);
  });

  test("a sidebar tombstone deletes the entry", () => {
    applyChanges(t.db, emptyFeed({
      next_since: 13, latest_seq: 13,
      tombstones: [{ kind: "sidebar", entity_id: "1" }],
    }));
    expect(count("SELECT COUNT(*) AS n FROM sidebar_entries")).toBe(0);
  });

  test("a child arriving before its parent in one window still applies", () => {
    const feed = emptyFeed({
      next_since: 14, latest_seq: 14,
      blocks: [
        block("uid_kid1", 2, { parent_uid: "uid_mum1" }),
        block("uid_mum1", 2, { order_idx: 3 }),
      ],
    });
    expect(applyChanges(t.db, feed).status).toBe("applied");
    expect(count("SELECT COUNT(*) AS n FROM blocks WHERE page_id = 2")).toBe(2);
  });

  test("reset:true requests a re-bootstrap and applies nothing", () => {
    const feed = emptyFeed({ reset: true, blocks: [block("uid_zz1", 1)] });
    expect(applyChanges(t.db, feed)).toEqual({ status: "needs-bootstrap" });
    expect(count("SELECT COUNT(*) AS n FROM blocks")).toBe(3);
  });

  test("a generation flip requests a re-bootstrap without partial metadata", () => {
    const feed = emptyFeed({
      generation: "gen-2",
      plain_space_title_canonicalization: true,
      next_since: 99,
    });
    expect(applyChanges(t.db, feed)).toEqual({ status: "needs-bootstrap" });
    expect(getMeta(t.db, "cursor")).toBe("10");
    expect(getMeta(t.db, "generation")).toBe("gen-1");
    expect(getMeta(t.db, "plain_space_title_canonicalization")).toBe("0");
  });

  test("an empty feed just advances the cursor", () => {
    expect(applyChanges(t.db, emptyFeed({ next_since: 11, latest_seq: 11 })))
      .toEqual({ status: "applied", cursor: 11 });
    expect(getMeta(t.db, "cursor")).toBe("11");
  });
});

describe("applyChanges: a title moving between ids inside one window", () => {
  // pages.title and sidebar_entries.title are UNIQUE. The server only ever
  // holds one row per title, but a single window can carry the row that
  // gave a title up (a tombstone, or its own retitled row) together with the
  // row that took it over. Applying the taker before the giver has gone
  // used to trip UNIQUE, roll the window back, and refetch it forever
  // (pkm-n31j: "SIS" merged away as 3521, re-created as 4518, same window).
  test("a page deleted and re-created under a new id in one window", () => {
    const feed = emptyFeed({
      next_since: 20, latest_seq: 20,
      pages: [page(3, "AI")],
      tombstones: [{ kind: "page", entity_id: "2" }],
    });
    expect(applyChanges(t.db, feed)).toEqual({ status: "applied", cursor: 20 });
    expect(t.db.select("SELECT id, title FROM pages ORDER BY id")).toEqual([
      { id: 1, title: "Machine Learning" }, { id: 3, title: "AI" },
    ]);
  });

  test("two pages swapping titles in one window", () => {
    const feed = emptyFeed({
      next_since: 20, latest_seq: 20,
      pages: [page(1, "AI"), page(2, "Machine Learning")],
    });
    expect(applyChanges(t.db, feed)).toEqual({ status: "applied", cursor: 20 });
    expect(t.db.select("SELECT id, title FROM pages ORDER BY id")).toEqual([
      { id: 1, title: "AI" }, { id: 2, title: "Machine Learning" },
    ]);
    // the FTS mirror followed both retitles, and the parking placeholder
    // left nothing behind in it
    expect(t.db.select("SELECT rowid FROM pages_fts WHERE pages_fts MATCH 'learning'"))
      .toEqual([{ rowid: 2 }]);
    expect(t.db.select("SELECT rowid FROM pages_fts WHERE pages_fts MATCH 'parked'"))
      .toEqual([]);
  });

  test("an offline-created page taking an incoming title is remapped, not parked", () => {
    // Negative ids belong to reconcilePage (blocks and refs move onto the
    // authoritative row); parking one would break its title match.
    enqueueBatch(t.db, [{ op: "create", uid: "uid_new1", page_title: "New",
                          parent_uid: null, order_idx: 0, text: "hi" }], 5, "batch-n");
    expect(t.db.select("SELECT id FROM pages WHERE title = 'New'")).toEqual([{ id: -1 }]);
    const feed = emptyFeed({ next_since: 20, latest_seq: 20, pages: [page(9, "New")] });
    expect(applyChanges(t.db, feed)).toEqual({ status: "applied", cursor: 20 });
    expect(t.db.select("SELECT id FROM pages WHERE title = 'New'")).toEqual([{ id: 9 }]);
    expect(t.db.select("SELECT page_id FROM blocks WHERE uid = 'uid_new1'"))
      .toEqual([{ page_id: 9 }]);
  });

  test("a title taken over from a row this window says nothing about re-bootstraps", () => {
    // The server cannot hold two "AI" rows, so a local positive-id "AI" that
    // is neither retitled nor tombstoned here means this replica's picture of
    // it is stale in a way no window can fix. Rebuild rather than wedge.
    const feed = emptyFeed({ next_since: 20, latest_seq: 20, pages: [page(3, "AI")] });
    expect(applyChanges(t.db, feed)).toEqual({ status: "needs-bootstrap" });
    expect(getMeta(t.db, "cursor")).toBe("10");
    expect(t.db.select("SELECT id, title FROM pages ORDER BY id")).toEqual([
      { id: 1, title: "Machine Learning" }, { id: 2, title: "AI" },
    ]);
  });

  test("a sidebar entry deleted and re-created under a new id in one window", () => {
    const feed = emptyFeed({
      next_since: 20, latest_seq: 20,
      sidebar: [{ id: 7, title: "AI", order_idx: 0 }],
      tombstones: [{ kind: "sidebar", entity_id: "1" }],
    });
    expect(applyChanges(t.db, feed)).toEqual({ status: "applied", cursor: 20 });
    expect(t.db.select("SELECT id, title FROM sidebar_entries"))
      .toEqual([{ id: 7, title: "AI" }]);
  });

  test("two sidebar entries swapping titles in one window", () => {
    applyChanges(t.db, emptyFeed({
      next_since: 15, latest_seq: 15,
      sidebar: [{ id: 2, title: "Machine Learning", order_idx: 1 }],
    }));
    const feed = emptyFeed({
      next_since: 20, latest_seq: 20,
      sidebar: [{ id: 1, title: "Machine Learning", order_idx: 0 },
                { id: 2, title: "AI", order_idx: 1 }],
    });
    expect(applyChanges(t.db, feed)).toEqual({ status: "applied", cursor: 20 });
    expect(t.db.select("SELECT id, title FROM sidebar_entries ORDER BY id")).toEqual([
      { id: 1, title: "Machine Learning" }, { id: 2, title: "AI" },
    ]);
  });
});
