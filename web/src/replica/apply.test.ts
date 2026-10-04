// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type { BatchId, BlockUid, CanonicalTitle, PageId, SyncSeq } from "../api/brands";
import type { Changes, Snapshot, SyncBlock, SyncTombstone } from "./apply";
import { applyChanges, applySnapshot, assertNoParkedTitles,
         parkTakenTitles } from "./apply";
import type { BlockOp } from "../api/ops";
import { applyLocalOps } from "./localOps";
import { getMeta, setMeta } from "./meta";
import { allBatches, deleteBatch, enqueueBatch, markPoisoned, nextBatch } from "./queue";
import { openTestDb, type TestDb } from "./testDb";
import type { ReplicaDb } from "./db";
import { entryId, ord, pageId, title, uid } from "../test-helpers";

// Every test here picks an arbitrary batch-id string, same shape as the
// production mint; this mints the brand once rather than at every call.
const bid = (s: string): BatchId => s as BatchId;

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
  generation: "gen-1", plain_space_title_canonicalization: false,
  seq: 10 as SyncSeq,
  pages: [page(1, "Machine Learning"), page(2, "AI")],
  blocks: [
    block("uid_b1", 1, { text: "links [[AI]]", refs: [{ target_page_id: pageId(2), kind: "link" }] }),
    block("uid_b2", 1, { order_idx: ord(1) }),
    block("uid_b3", 1, { parent_uid: uid("uid_b2"), text: "child block searchable" }),
  ],
  sidebar: [{ id: entryId(1), title: title("AI"), order_idx: 0 }],
};

// `next_since`/`latest_seq` take a plain number here, not SyncSeq: every
// caller in this file picks arbitrary small test cursors, and casting each
// one individually would bury the fixture building in brand noise.
const emptyFeed = (over: Omit<Partial<Changes>, "next_since" | "latest_seq"> &
  { next_since?: number; latest_seq?: number } = {}): Changes => ({
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: 10, latest_seq: 10,
  pages: [], blocks: [], sidebar: [], tombstones: [], ...over,
} as Changes);

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
      sidebar: [{ id: entryId(30), title: title("Authoritative #Page"), order_idx: 0 }],
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
      { op: "create", uid: uid("uid_opt"), page_title: "Machine Learning",
        parent_uid: null, order_idx: ord(0), text: "typed during bootstrap" },
    ], 5, bid("batch-opt"));
    applySnapshot(t.db, SNAP, 6);
    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_opt'"))
      .toEqual([{ text: "typed during bootstrap" }]);
    // the batch itself still flushes to the server untouched
    expect(count("SELECT COUNT(*) AS n FROM pending_ops WHERE poisoned = 0"))
      .toBe(1);
  });

  test("a queued batch that no longer applies is skipped, not fatal", () => {
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_keep"), page_title: "AI",
        parent_uid: null, order_idx: ord(0), text: "kept" },
    ], 5, bid("batch-keep"));
    // references a block that exists now but is not in the snapshot and
    // is created by no queued batch: unappliable after the wipe
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text," +
      " heading, collapsed, created_at, updated_at)" +
      " VALUES ('uid_gone_after_wipe', 1, NULL, 9, 'x', NULL, 0, 5, 5)");
    enqueueBatch(t.db, [
      { op: "set_heading", uid: uid("uid_gone_after_wipe"), heading: 1 },
    ], 5, bid("batch-doomed"));
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
      { op: "update_text", uid: uid("uid_b1"), text: "rejected text" },
      { op: "move", uid: uid("uid_b2"), page_title: "Machine Learning",
        parent_uid: uid("uid_b1"), order_idx: ord(0) },
    ], 5, bid("batch-rejected"));
    const rejected = nextBatch(t.db)!;
    markPoisoned(t.db, rejected.id, JSON.stringify({
      status: 400, message: "request failed: 400 /api/ops",
    }), bid("batch-rejected"));
    enqueueBatch(t.db, [
      { op: "set_heading", uid: uid("uid_b3"), heading: 2 },
    ], 5, bid("batch-valid"));

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
    deleteBatch(t.db, rejected.id, rejected.batch_id);
    enqueueBatch(t.db, [
      { op: "update_text", uid: uid("uid_b1"), text: "later valid text" },
    ], 7, bid("batch-later-valid"));
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
      generation: "gen-2", plain_space_title_canonicalization: true,
      seq: 4 as SyncSeq,
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
      sidebar: [{ id: entryId(31), title: title("Authoritative [[Feed]]"), order_idx: 0 }],
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
    ], 5, bid("pending-create-page"));
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_pending1"), page_title: "  Created Block Target  ",
        parent_uid: null, order_idx: ord(0), text: "pending create" },
    ], 5, bid("pending-create"));
    enqueueBatch(t.db, [
      { op: "move", uid: uid("uid_b2"), parent_uid: null, order_idx: ord(0),
        page_title: "  Moved Block Target  " },
    ], 5, bid("pending-move"));

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
    // spurious daily-note conflict header
    enqueueBatch(t.db, [
      { op: "update_text", uid: uid("uid_b1"), text: "local newer text" },
    ], 5, bid("b-opt"));
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
        refs: [{ target_page_id: pageId(1), kind: "link" }],
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
    // block's own text on every upsert.
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
        text: "still [[AI]]", refs: [{ target_page_id: pageId(2), kind: "link" }] })],
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

  test("a page tombstone and a sidebar tombstone with the same numeric id" +
       " each delete only their own row", () => {
    applyChanges(t.db, emptyFeed({
      next_since: 13, latest_seq: 13,
      tombstones: [{ kind: "page", entity_id: "1" }],
    }));
    expect(count("SELECT COUNT(*) AS n FROM pages WHERE id = 1")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM sidebar_entries WHERE id = 1")).toBe(1);

    applyChanges(t.db, emptyFeed({
      next_since: 14, latest_seq: 14,
      tombstones: [{ kind: "sidebar", entity_id: "1" }],
    }));
    expect(count("SELECT COUNT(*) AS n FROM sidebar_entries WHERE id = 1")).toBe(0);
  });

  test("parkTakenTitles/assertNoParkedTitles tie the parked ids to their own table", () => {
    // a title nothing holds: parks nothing, so assertNoParkedTitles is a no-op
    const parkedPages = parkTakenTitles(t.db, "pages",
      [{ id: pageId(2), title: title("a title nothing holds") }]);
    assertNoParkedTitles(t.db, "pages", parkedPages);
    // @ts-expect-error a pages table's parked ids aren't a sidebar entry's
    assertNoParkedTitles(t.db, "sidebar_entries", parkedPages);
  });

  test("a title still parked once the upserts ran trips assertNoParkedTitles", () => {
    // page 3 arrives holding page 2's "AI": page 2 is parked, and nothing
    // in this (simulated) window gives it a real title back
    const parked = parkTakenTitles(t.db, "pages", [{ id: pageId(3), title: title("AI") }]);
    expect(parked).toEqual([2]);
    expect(() => assertNoParkedTitles(t.db, "pages", parked))
      .toThrow(/pages rows 2 hold titles/);
  });

  // An older replica may meet a tombstone kind the server added after it
  // shipped. Dispatch must not default to a sidebar delete for it --
  // that would destroy an unrelated row (see applyWindow).
  test("an unknown tombstone kind deletes nothing", () => {
    applyChanges(t.db, emptyFeed({
      next_since: 13, latest_seq: 13,
      tombstones: [{ kind: "widget", entity_id: "1" } as unknown as SyncTombstone],
    }));
    expect(count("SELECT COUNT(*) AS n FROM sidebar_entries")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM pages")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM blocks")).toBe(3);
  });

  test("a child arriving before its parent in one window still applies", () => {
    const feed = emptyFeed({
      next_since: 14, latest_seq: 14,
      blocks: [
        block("uid_kid1", 2, { parent_uid: uid("uid_mum1") }),
        block("uid_mum1", 2, { order_idx: ord(3) }),
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
  // (e.g. a title merged away under one id and re-created under another
  // inside the same window).
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
    enqueueBatch(t.db, [{ op: "create", uid: uid("uid_new1"), page_title: "New",
                          parent_uid: null, order_idx: ord(0), text: "hi" }], 5, bid("batch-n"));
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
      sidebar: [{ id: entryId(7), title: title("AI"), order_idx: 0 }],
      tombstones: [{ kind: "sidebar", entity_id: "1" }],
    });
    expect(applyChanges(t.db, feed)).toEqual({ status: "applied", cursor: 20 });
    expect(t.db.select("SELECT id, title FROM sidebar_entries"))
      .toEqual([{ id: 7, title: "AI" }]);
  });

  test("two sidebar entries swapping titles in one window", () => {
    applyChanges(t.db, emptyFeed({
      next_since: 15, latest_seq: 15,
      sidebar: [{ id: entryId(2), title: title("Machine Learning"), order_idx: 1 }],
    }));
    const feed = emptyFeed({
      next_since: 20, latest_seq: 20,
      sidebar: [{ id: entryId(1), title: title("Machine Learning"), order_idx: 0 },
                { id: entryId(2), title: title("AI"), order_idx: 1 }],
    });
    expect(applyChanges(t.db, feed)).toEqual({ status: "applied", cursor: 20 });
    expect(t.db.select("SELECT id, title FROM sidebar_entries ORDER BY id")).toEqual([
      { id: 1, title: "Machine Learning" }, { id: 2, title: "AI" },
    ]);
  });
});

describe("applyChanges: a page id deleted and reused inside one window", () => {
  // SQLite gives the next insert max(id)+1, so deleting the highest page id
  // frees it for reuse, and the server ships
  // such an id as a tombstone and a live row in one window. Page tombstones lead:
  // the page's cascade clears what hung off the old page, then the upserts
  // bring back everything the window ships for the new one.
  test("the tombstone clears the old page's blocks and other blocks' refs before the new page lands", () => {
    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11, blocks: [block("uid_on_ai", 2)],
    }));
    expect(count("SELECT COUNT(*) AS n FROM blocks WHERE uid = 'uid_on_ai'")).toBe(1);
    const feed = emptyFeed({
      next_since: 12, latest_seq: 12,
      tombstones: [{ kind: "page", entity_id: "2" }],
      pages: [page(2, "Reborn")],
    });
    expect(applyChanges(t.db, feed)).toEqual({ status: "applied", cursor: 12 });
    expect(t.db.select("SELECT id, title FROM pages WHERE id = 2"))
      .toEqual([{ id: 2, title: "Reborn" }]);
    expect(count("SELECT COUNT(*) AS n FROM blocks WHERE uid = 'uid_on_ai'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM refs WHERE target_page_id = 2")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM blocks WHERE uid = 'uid_b1'")).toBe(1);
  });

  test("blocks the window ships for the reused page survive the tombstone", () => {
    const feed = emptyFeed({
      next_since: 12, latest_seq: 12,
      tombstones: [{ kind: "page", entity_id: "2" }],
      pages: [page(2, "Reborn")],
      blocks: [
        block("uid_new", 2),
        block("uid_b1", 1, { text: "links [[Reborn]]",
                             refs: [{ target_page_id: pageId(2), kind: "link" }] }),
      ],
    });
    expect(applyChanges(t.db, feed)).toEqual({ status: "applied", cursor: 12 });
    expect(t.db.select("SELECT page_id FROM blocks WHERE uid = 'uid_new'"))
      .toEqual([{ page_id: 2 }]);
    expect(t.db.select("SELECT target_page_id FROM refs WHERE src_block_uid = 'uid_b1'"))
      .toEqual([{ target_page_id: 2 }]);
  });

  test("a same-title recreate still drops the stale refs", () => {
    const feed = emptyFeed({
      next_since: 12, latest_seq: 12,
      tombstones: [{ kind: "page", entity_id: "2" }],
      pages: [page(2, "AI")],
    });
    expect(applyChanges(t.db, feed)).toEqual({ status: "applied", cursor: 12 });
    expect(t.db.select("SELECT id, title FROM pages WHERE id = 2"))
      .toEqual([{ id: 2, title: "AI" }]);
    expect(count("SELECT COUNT(*) AS n FROM refs WHERE target_page_id = 2")).toBe(0);
  });
});

describe("applyChanges: in one window, a block tombstone's cascade reaches only blocks the server deleted", () => {
  // The server journals every block it deletes, cascaded rows included, and
  // ships each tombstone in the window holding its delete row. A descendant
  // that moved along with a moved-out ancestor changed no row of its own, so
  // only the ancestor's row ships: the window's upserts have to take the
  // subtree out from under the tombstoned block before its local cascade
  // runs.
  const tree = () => t.db.select<{ uid: string; page_id: number;
                                   parent_uid: string | null }>(
    "SELECT uid, page_id, parent_uid FROM blocks ORDER BY uid");
  beforeEach(() => {
    // uid_p > uid_c > uid_g on Machine Learning, and a page that will go
    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      pages: [page(3, "Doomed")],
      blocks: [
        block("uid_p", 1, { order_idx: ord(2) }),
        block("uid_c", 1, { parent_uid: uid("uid_p") }),
        block("uid_g", 1, { parent_uid: uid("uid_c"), text: "grandchild searchable" }),
        block("uid_x", 3),
        block("uid_y", 3, { parent_uid: uid("uid_x") }),
      ],
    }));
  });

  test("a block moved out from under a parent deleted in the same window keeps its subtree", () => {
    const result = applyChanges(t.db, emptyFeed({
      next_since: 12, latest_seq: 12,
      tombstones: [{ kind: "block", entity_id: "uid_p" }],
      blocks: [block("uid_c", 1, { order_idx: ord(3) })],
    }));
    expect(result).toEqual({ status: "applied", cursor: 12 });
    expect(tree().filter((r) => ["uid_p", "uid_c", "uid_g"].includes(r.uid)))
      .toEqual([
        { uid: "uid_c", page_id: 1, parent_uid: null },
        { uid: "uid_g", page_id: 1, parent_uid: "uid_c" },
      ]);
    expect(ftsHits("grandchild")).toEqual(["uid_g"]);
  });

  test("a block moved off a page deleted in the same window keeps its subtree", () => {
    // leaving a page rewrites every block of the moved subtree (page_id),
    // so the server ships the child's row too
    const result = applyChanges(t.db, emptyFeed({
      next_since: 12, latest_seq: 12,
      tombstones: [{ kind: "page", entity_id: "3" }],
      blocks: [block("uid_x", 1, { order_idx: ord(3) }),
               block("uid_y", 1, { parent_uid: uid("uid_x") })],
    }));
    expect(result).toEqual({ status: "applied", cursor: 12 });
    expect(tree().filter((r) => ["uid_x", "uid_y"].includes(r.uid))).toEqual([
      { uid: "uid_x", page_id: 1, parent_uid: null },
      { uid: "uid_y", page_id: 1, parent_uid: "uid_x" },
    ]);
    expect(count("SELECT COUNT(*) AS n FROM pages WHERE id = 3")).toBe(0);
  });

  test("a subtree the server deleted is still removed", () => {
    // the server's journal tombstones every block of a deleted subtree
    const result = applyChanges(t.db, emptyFeed({
      next_since: 12, latest_seq: 12,
      tombstones: [{ kind: "block", entity_id: "uid_p" },
                   { kind: "block", entity_id: "uid_c" },
                   { kind: "block", entity_id: "uid_g" }],
    }));
    expect(result).toEqual({ status: "applied", cursor: 12 });
    expect(count("SELECT COUNT(*) AS n FROM blocks WHERE uid IN" +
                 " ('uid_p', 'uid_c', 'uid_g')")).toBe(0);
    expect(ftsHits("grandchild")).toEqual([]);
    expect(t.db.select("PRAGMA foreign_key_check")).toEqual([]);
  });

  test("a page merged into a new page under its title moves its blocks across", () => {
    // a merge: page 3's blocks move to a new page 4 that takes its title,
    // and page 3 goes, all in one window
    const result = applyChanges(t.db, emptyFeed({
      next_since: 12, latest_seq: 12,
      tombstones: [{ kind: "page", entity_id: "3" }],
      pages: [page(4, "Doomed")],
      blocks: [block("uid_x", 4), block("uid_y", 4, { parent_uid: uid("uid_x") })],
    }));
    expect(result).toEqual({ status: "applied", cursor: 12 });
    expect(t.db.select("SELECT id FROM pages WHERE title = 'Doomed'"))
      .toEqual([{ id: 4 }]);
    expect(tree().filter((r) => ["uid_x", "uid_y"].includes(r.uid))).toEqual([
      { uid: "uid_x", page_id: 4, parent_uid: null },
      { uid: "uid_y", page_id: 4, parent_uid: "uid_x" },
    ]);
  });

  test("a pending create under the deleted parent goes; one under the moved-out child stays", () => {
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_ghost_p"), page_title: "Machine Learning",
        parent_uid: uid("uid_p"), order_idx: ord(1), text: "typed under p" },
      { op: "create", uid: uid("uid_ghost_c"), page_title: "Machine Learning",
        parent_uid: uid("uid_c"), order_idx: ord(1), text: "typed under c" },
    ], 5, bid("batch-ghosts"));
    expect(count("SELECT COUNT(*) AS n FROM blocks WHERE uid LIKE 'uid_ghost_%'"))
      .toBe(2);

    const result = applyChanges(t.db, emptyFeed({
      next_since: 12, latest_seq: 12,
      tombstones: [{ kind: "block", entity_id: "uid_p" }],
      blocks: [block("uid_c", 1, { order_idx: ord(3) })],
    }), 6);

    expect(result).toEqual({ status: "applied", cursor: 12 });
    expect(tree().filter((r) => r.uid.startsWith("uid_ghost_") ||
                                ["uid_c", "uid_g"].includes(r.uid))).toEqual([
      { uid: "uid_c", page_id: 1, parent_uid: null },
      { uid: "uid_g", page_id: 1, parent_uid: "uid_c" },
      { uid: "uid_ghost_c", page_id: 1, parent_uid: "uid_c" },
    ]);
    // the queue is the user's intent: the batch still flushes
    expect(allBatches(t.db)).toHaveLength(1);
    expect(t.db.select("PRAGMA foreign_key_check")).toEqual([]);
  });
});

describe("applyChanges: block tombstones wait for the window that reaches the journal head", () => {
  // D > A > K > L; then s12 moves A to the top level, s13 deletes D, s14
  // moves K to the top level, s15 deletes A. The server ends with K > L.
  // Caught up one journal row per window: A's move ships nothing (A is
  // absent now and its delete row lies in a later window), so D's
  // tombstone, cascaded at once, would take the stale D > A > K > L, and
  // L's row never changes to ship again.
  const tree = () => t.db.select<{ uid: string; parent_uid: string | null }>(
    "SELECT uid, parent_uid FROM blocks WHERE uid LIKE 'uid_dd_%' ORDER BY uid");
  const deferred = (): string[] | null => {
    const raw = getMeta(t.db, "deferred_block_tombstones");
    return raw === null ? null : (JSON.parse(raw) as { uids: string[] }).uids;
  };
  const window = (next: number, over: Partial<Changes> = {}) =>
    applyChanges(t.db, emptyFeed({ next_since: next, latest_seq: 15, ...over }));
  const tomb = (raw: string): SyncTombstone => ({ kind: "block", entity_id: raw });
  beforeEach(() => {
    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      blocks: [
        block("uid_dd_d", 1, { order_idx: ord(2) }),
        block("uid_dd_a", 1, { parent_uid: uid("uid_dd_d") }),
        block("uid_dd_k", 1, { parent_uid: uid("uid_dd_a") }),
        block("uid_dd_l", 1, { parent_uid: uid("uid_dd_k"), text: "leaf searchable" }),
      ],
    }));
  });

  test("windows of one row end with the server's K > L", () => {
    expect(window(12)).toEqual({ status: "applied", cursor: 12 });
    expect(window(13, { tombstones: [tomb("uid_dd_d")] }))
      .toEqual({ status: "applied", cursor: 13 });
    expect(window(14, { blocks: [block("uid_dd_k", 1, { order_idx: ord(3) })] }))
      .toEqual({ status: "applied", cursor: 14 });
    expect(window(15, { tombstones: [tomb("uid_dd_a")] }))
      .toEqual({ status: "applied", cursor: 15 });

    expect(tree()).toEqual([
      { uid: "uid_dd_k", parent_uid: null },
      { uid: "uid_dd_l", parent_uid: "uid_dd_k" },
    ]);
    expect(ftsHits("leaf")).toEqual(["uid_dd_l"]);
    expect(deferred()).toBeNull();
    expect(t.db.select("PRAGMA foreign_key_check")).toEqual([]);
  });

  test("a window short of the head leaves the tombstoned block and records its uid", () => {
    window(12);
    window(13, { tombstones: [tomb("uid_dd_d")] });

    // the replica looks older, not wrongly shaped: D is still there
    expect(tree()).toEqual([
      { uid: "uid_dd_a", parent_uid: "uid_dd_d" },
      { uid: "uid_dd_d", parent_uid: null },
      { uid: "uid_dd_k", parent_uid: "uid_dd_a" },
      { uid: "uid_dd_l", parent_uid: "uid_dd_k" },
    ]);
    expect(deferred()).toEqual(["uid_dd_d"]);
    expect(getMeta(t.db, "cursor")).toBe("13");
  });

  test("the recorded uids accumulate across windows, once each, in order", () => {
    window(13, { tombstones: [tomb("uid_dd_d")] });
    window(13, { tombstones: [tomb("uid_dd_d")] }); // the same window re-pulled
    window(14, { tombstones: [tomb("uid_dd_l"), tomb("uid_dd_d")] });

    expect(deferred()).toEqual(["uid_dd_d", "uid_dd_l"]);
    expect(count("SELECT COUNT(*) AS n FROM blocks WHERE uid LIKE 'uid_dd_%'"))
      .toBe(4);

    window(15);
    expect(tree()).toEqual([]);
    expect(deferred()).toBeNull();
  });

  test("a window that reaches the head with nothing in it still applies the recorded tombstones", () => {
    window(13, { tombstones: [tomb("uid_dd_k")] });
    expect(window(15)).toEqual({ status: "applied", cursor: 15 });

    expect(tree()).toEqual([
      { uid: "uid_dd_a", parent_uid: "uid_dd_d" },
      { uid: "uid_dd_d", parent_uid: null },
    ]);
    expect(deferred()).toBeNull();
  });

  test("a block a later window ships live drops its recorded tombstone", () => {
    // deleted, then recreated by an undo under the same uid: the live row
    // was read later than the tombstone
    window(13, { tombstones: [tomb("uid_dd_l")] });
    window(14, { blocks: [block("uid_dd_l", 1, { parent_uid: uid("uid_dd_k"),
                                                 text: "leaf searchable" })] });
    expect(deferred()).toBeNull();

    window(15);
    expect(tree()).toHaveLength(4);
  });

  test("the record carries the cursor its window wrote", () => {
    window(13, { tombstones: [tomb("uid_dd_d")] });
    expect(JSON.parse(getMeta(t.db, "deferred_block_tombstones")!))
      .toEqual({ cursor: 13, uids: ["uid_dd_d"] });
  });

  test("a record whose cursor no longer matches is void at the head window", () => {
    window(13, { tombstones: [tomb("uid_dd_d")] });
    // a build without the rule advanced the cursor past the record
    setMeta(t.db, "cursor", "14");
    expect(window(15)).toEqual({ status: "applied", cursor: 15 });

    expect(count("SELECT COUNT(*) AS n FROM blocks WHERE uid LIKE 'uid_dd_%'"))
      .toBe(4);
    expect(deferred()).toBeNull();
  });

  test("a void record is replaced by the short window's own tombstones", () => {
    window(13, { tombstones: [tomb("uid_dd_d")] });
    setMeta(t.db, "cursor", "14");
    window(14, { tombstones: [tomb("uid_dd_l")] });

    expect(deferred()).toEqual(["uid_dd_l"]);
  });

  test("a window that rolls back records nothing", () => {
    // a block whose page never shipped fails the deferred FK check at COMMIT
    expect(window(13, {
      tombstones: [tomb("uid_dd_d")],
      blocks: [block("uid_dd_orphan", 99)],
    })).toEqual({ status: "needs-bootstrap" });

    expect(deferred()).toBeNull();
    expect(getMeta(t.db, "cursor")).toBe("11");
  });

  test("a snapshot clears the recorded tombstones", () => {
    window(13, { tombstones: [tomb("uid_dd_d")] });
    expect(deferred()).toEqual(["uid_dd_d"]);

    applySnapshot(t.db, SNAP);
    expect(deferred()).toBeNull();
  });

  test("a pending create under a block tombstoned short of the head goes once the head is reached", () => {
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_dd_ghost"), page_title: "Machine Learning",
        parent_uid: uid("uid_dd_d"), order_idx: ord(1), text: "typed under d" },
    ], 5, bid("batch-dd-ghost"));

    window(13, { tombstones: [tomb("uid_dd_d")] });
    expect(count("SELECT COUNT(*) AS n FROM blocks WHERE uid = 'uid_dd_ghost'"))
      .toBe(1);

    window(15, { tombstones: [tomb("uid_dd_a")],
                 blocks: [block("uid_dd_k", 1, { order_idx: ord(3) })] });
    expect(tree()).toEqual([
      { uid: "uid_dd_k", parent_uid: null },
      { uid: "uid_dd_l", parent_uid: "uid_dd_k" },
    ]);
    expect(allBatches(t.db)).toHaveLength(1);
    expect(t.db.select("PRAGMA foreign_key_check")).toEqual([]);
  });
});

describe("applySnapshot and applyChanges: a create under a ghost parent keeps the rest of its batch", () => {
  // Regression for the bean: a pending batch [create C under parent G,
  // update_text L] optimistically applies both while G is still present
  // locally. When G is later gone (a snapshot that omits it, or a window
  // that tombstones it), reapplyPending used to roll the WHOLE batch back
  // -- C's dangling parent_uid added an FK violation the savepoint diff
  // caught -- reverting L to its server text even though L's own op had
  // nothing wrong with it. The fix skips the create (its parent is
  // missing) instead of inserting the dangling row, so L's update
  // survives the replay.
  const enqueueGhostBatch = (batchId: BatchId) => {
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text," +
      " heading, collapsed, created_at, updated_at)" +
      " VALUES ('uid_ghost1', 1, NULL, 9, 'ghost parent', NULL, 0, 5, 5)");
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_child1"), page_title: "Machine Learning",
        parent_uid: uid("uid_ghost1"), order_idx: ord(0), text: "lost child" },
      { op: "update_text", uid: uid("uid_b1"), text: "mine" },
    ], 5, batchId);
    // optimistic apply landed both ops while the ghost parent still existed
    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'"))
      .toEqual([{ text: "mine" }]);
  };

  test("snapshot lacking the ghost parent", () => {
    enqueueGhostBatch(bid("batch-ghost-snap"));

    applySnapshot(t.db, SNAP, 6); // SNAP has no uid_ghost1; uid_b1 at server text

    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'"))
      .toEqual([{ text: "mine" }]);
    expect(t.db.select("SELECT uid FROM blocks WHERE uid = 'uid_child1'"))
      .toEqual([]);
    const batches = allBatches(t.db);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      batch_id: bid("batch-ghost-snap"), poisoned: false,
    });
  });

  test("windowed applyChanges tombstoning the ghost parent and re-shipping the sibling", () => {
    enqueueGhostBatch(bid("batch-ghost-window"));

    const result = applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      tombstones: [{ kind: "block", entity_id: "uid_ghost1" }],
      blocks: [block("uid_b1", 1, {
        text: "links [[AI]]", refs: [{ target_page_id: pageId(2), kind: "link" }],
      })],
    }), 6);

    expect(result).toEqual({ status: "applied", cursor: 11 });
    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'"))
      .toEqual([{ text: "mine" }]);
    expect(t.db.select("SELECT uid FROM blocks WHERE uid = 'uid_child1'"))
      .toEqual([]);
    const batches = allBatches(t.db);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      batch_id: bid("batch-ghost-window"), poisoned: false,
    });
  });
});

describe("applyChanges: a windowed reapply keeps a batch whose create already applied", () => {
  // A window does not wipe the replica, so a pending create finds its own
  // row from the enqueue-time apply. That used to fail the INSERT and roll
  // the whole batch back for the window, reverting its other ops.
  const topLevel = () => t.db.select<{ uid: string; order_idx: number }>(
    "SELECT uid, order_idx FROM blocks WHERE page_id = 1" +
    " AND parent_uid IS NULL ORDER BY order_idx, uid");
  const enqueueCreateAndEdit = () => enqueueBatch(t.db, [
    { op: "create", uid: uid("uid_new1"), page_title: "Machine Learning",
      parent_uid: null, order_idx: ord(1), text: "fresh" },
    { op: "update_text", uid: uid("uid_b1"), text: "mine" },
  ], 5, bid("batch-create"));
  const expectStillPending = () => {
    const batches = allBatches(t.db);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      batch_id: bid("batch-create"), poisoned: false,
    });
  };

  test("a window re-shipping a block the batch edits keeps the optimistic text", () => {
    enqueueCreateAndEdit();

    const result = applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      blocks: [block("uid_b1", 1, { text: "another device" })],
    }), 6);

    expect(result).toEqual({ status: "applied", cursor: 11 });
    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'"))
      .toEqual([{ text: "mine" }]);
    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_new1'"))
      .toEqual([{ text: "fresh" }]);
    expect(topLevel()).toEqual([
      { uid: "uid_b1", order_idx: 0 },
      { uid: "uid_new1", order_idx: 1 },
      { uid: "uid_b2", order_idx: 2 },
    ]);
    expectStillPending();
  });

  test("our own echo landing before the ack matches the server exactly", () => {
    enqueueCreateAndEdit();

    // the server applied the batch: it shifted uid_b2 and journaled all three
    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      blocks: [
        block("uid_new1", 1, { order_idx: ord(1), text: "fresh" }),
        block("uid_b1", 1, { text: "mine" }),
        block("uid_b2", 1, { order_idx: ord(2) }),
      ],
    }), 6);

    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'"))
      .toEqual([{ text: "mine" }]);
    expect(topLevel()).toEqual([
      { uid: "uid_b1", order_idx: 0 },
      { uid: "uid_new1", order_idx: 1 },
      { uid: "uid_b2", order_idx: 2 },
    ]);
    expectStillPending();
  });

  test("a sibling re-shipped onto the created block's slot is moved past it", () => {
    enqueueCreateAndEdit();

    // another device edited uid_b2; the server has not seen our create, so
    // it ships uid_b2 at its unshifted index -- the slot uid_new1 holds
    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      blocks: [block("uid_b2", 1, { order_idx: ord(1), text: "edited elsewhere" })],
    }), 6);

    expect(topLevel().map((r) => r.uid))
      .toEqual(["uid_b1", "uid_new1", "uid_b2"]);
  });

  test("windows that do not touch its siblings leave their order_idx alone", () => {
    enqueueCreateAndEdit();
    for (const seq of [11, 12, 13]) {
      applyChanges(t.db, emptyFeed({ next_since: seq, latest_seq: seq }), 6);
    }
    expect(topLevel()).toEqual([
      { uid: "uid_b1", order_idx: 0 },
      { uid: "uid_new1", order_idx: 1 },
      { uid: "uid_b2", order_idx: 2 },
    ]);
  });
});

describe("applyChanges: a replayed move does not re-shift siblings it already made room past", () => {
  const topLevel = () => t.db.select<{ uid: string; order_idx: number }>(
    "SELECT uid, order_idx FROM blocks WHERE page_id = 1" +
    " AND parent_uid IS NULL ORDER BY order_idx, uid");

  test("sibling order_idx is stable across windows", () => {
    enqueueBatch(t.db, [
      { op: "move", uid: uid("uid_b3"), parent_uid: null, order_idx: ord(1) },
    ], 5, bid("batch-move"));
    for (const seq of [11, 12, 13]) {
      applyChanges(t.db, emptyFeed({ next_since: seq, latest_seq: seq }), 6);
    }
    expect(topLevel()).toEqual([
      { uid: "uid_b1", order_idx: 0 },
      { uid: "uid_b3", order_idx: 1 },
      { uid: "uid_b2", order_idx: 2 },
    ]);
  });

  test("drift no longer lets a re-shipped sibling overtake a drifted one", () => {
    // a third sibling so one can be re-shipped below another's drifted index
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text," +
      " heading, collapsed, created_at, updated_at)" +
      " VALUES ('uid_b4', 1, NULL, 2, 'fourth', NULL, 0, 1, 1)");
    enqueueBatch(t.db, [
      { op: "move", uid: uid("uid_b3"), parent_uid: null, order_idx: ord(1) },
    ], 5, bid("batch-move"));
    for (const seq of [11, 12]) {
      applyChanges(t.db, emptyFeed({ next_since: seq, latest_seq: seq }), 6);
    }
    // another device edits uid_b4; the server ships it at its own index 2
    applyChanges(t.db, emptyFeed({
      next_since: 13, latest_seq: 13,
      blocks: [block("uid_b4", 1, { order_idx: ord(2), text: "edited elsewhere" })],
    }), 6);
    expect(topLevel().map((r) => r.uid))
      .toEqual(["uid_b1", "uid_b3", "uid_b2", "uid_b4"]);
  });
});

describe("applyChanges: concurrent structure edits converge without a snapshot repair", () => {
  // The server no longer 400s these batches (a 400 used to buy a snapshot
  // repair that also cleaned the optimistic state), so the replica has to
  // reach the server's rows from the feed alone.
  const tree = () => t.db.select<{ uid: string; page_id: number;
                                   parent_uid: string | null;
                                   order_idx: number }>(
    "SELECT uid, page_id, parent_uid, order_idx FROM blocks ORDER BY uid");
  // Another device moved uid_b2 (and its child uid_b3) under uid_b1 before
  // our move of uid_b1 under uid_b3 reached the server, so ours would
  // nest uid_b1 under its own descendant: the server skips it.
  const SERVER_AFTER_CYCLE = [
    { uid: "uid_b1", page_id: 1, parent_uid: null, order_idx: 0 },
    { uid: "uid_b2", page_id: 1, parent_uid: "uid_b1", order_idx: 0 },
    { uid: "uid_b3", page_id: 1, parent_uid: "uid_b2", order_idx: 0 },
  ];
  const serverBlocks = () => [
    // feed order is journal order: the other device's move of uid_b2
    // first, then the skipped move's re-shipped subtree, root first. The
    // first row closes a loop over our optimistic uid_b1 -> uid_b3; the
    // rows after it must open it again.
    block("uid_b2", 1, { parent_uid: uid("uid_b1") }),
    block("uid_b1", 1, { text: "links [[AI]]",
                         refs: [{ target_page_id: pageId(2), kind: "link" }] }),
    block("uid_b3", 1, { parent_uid: uid("uid_b2"), text: "mine" }),
  ];
  const enqueueCycleMove = () => enqueueBatch(t.db, [
    { op: "move", uid: uid("uid_b1"), parent_uid: uid("uid_b3"), order_idx: ord(0) },
    { op: "update_text", uid: uid("uid_b3"), text: "mine" },
  ], 5, bid("batch-cycle"));

  test("an acked cycle move is undone by the rows the server journals for it", () => {
    enqueueCycleMove();
    expect(tree()[0]).toMatchObject({ uid: "uid_b1", parent_uid: "uid_b3" });
    ackNext(t.db); // the ack, skipped: cycle

    const result = applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11, blocks: serverBlocks(),
    }), 6);

    expect(result).toEqual({ status: "applied", cursor: 11 });
    expect(tree()).toEqual(SERVER_AFTER_CYCLE);
    expect(t.db.select("PRAGMA foreign_key_check")).toEqual([]);
  });

  test("a window before the ack, then the ack's journal rows, converge", () => {
    enqueueCycleMove();
    // The other device's move arrives while ours is still queued. The
    // server's parent closure ships uid_b2's ancestors with it, and our
    // moved uid_b1 is one of them, so its real row lands in the same window.
    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      blocks: [block("uid_b2", 1, { parent_uid: uid("uid_b1") }),
               block("uid_b1", 1, { text: "links [[AI]]",
                                    refs: [{ target_page_id: pageId(2), kind: "link" }] })],
    }), 6);
    // no loop survives the window: the replay skips the move as a cycle,
    // and the batch's other op survives it
    expect(tree()).toEqual(SERVER_AFTER_CYCLE);
    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b3'"))
      .toEqual([{ text: "mine" }]);
    expect(allBatches(t.db)).toHaveLength(1);
    ackNext(t.db);

    applyChanges(t.db, emptyFeed({
      next_since: 12, latest_seq: 12, blocks: serverBlocks(),
    }), 7);

    expect(tree()).toEqual(SERVER_AFTER_CYCLE);
  });

  test("a snapshot under a pending cycle move keeps the server's tree", () => {
    // Replaying the move over a fresh snapshot would nest uid_b1 under its
    // own descendant, a loop no page root reaches: the whole subtree would
    // vanish from the page until the ack. Local apply skips it instead.
    enqueueCycleMove();

    applySnapshot(t.db, { ...SNAP, seq: 11 as SyncSeq, blocks: [
      block("uid_b1", 1, { text: "links [[AI]]",
                           refs: [{ target_page_id: pageId(2), kind: "link" }] }),
      block("uid_b2", 1, { parent_uid: uid("uid_b1") }),
      block("uid_b3", 1, { parent_uid: uid("uid_b2"), text: "child block searchable" }),
    ] }, 6);

    expect(tree()).toEqual(SERVER_AFTER_CYCLE);
    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b3'"))
      .toEqual([{ text: "mine" }]);
    expect(allBatches(t.db)).toHaveLength(1);
  });

  test("a pending create follows its parent when a window moves the parent to another page", () => {
    // Queued under uid_b2 on Machine Learning; another device moves uid_b2
    // (with uid_b3) to AI. The server will create our block on AI, beside
    // its parent, so the replay puts it there too.
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_new1"), page_title: "Machine Learning",
        parent_uid: uid("uid_b2"), order_idx: ord(1), text: "typed child" },
    ], 5, bid("batch-create"));

    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      blocks: [block("uid_b2", 2), block("uid_b3", 2, { parent_uid: uid("uid_b2") })],
    }), 6);

    expect(tree().find((r) => r.uid === "uid_new1")).toEqual(
      { uid: "uid_new1", page_id: 2, parent_uid: "uid_b2", order_idx: 1 });

    // the ack, then the server's own row for the create
    ackNext(t.db);
    applyChanges(t.db, emptyFeed({
      next_since: 12, latest_seq: 12,
      blocks: [block("uid_new1", 2, { parent_uid: uid("uid_b2"), order_idx: ord(1),
                                      text: "typed child" })],
    }), 7);
    expect(tree().find((r) => r.uid === "uid_new1")).toEqual(
      { uid: "uid_new1", page_id: 2, parent_uid: "uid_b2", order_idx: 1 });
  });

  test("a replayed create does not re-page a block a later pending move took elsewhere", () => {
    // Created under uid_b2, then moved under uid_b1 (same page) by a later
    // pending batch. A window moves uid_b2 to AI. The create replay must
    // leave the block where the move put it: re-paging it there would make
    // the move replay re-shift uid_b1's children on every window.
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text," +
      " heading, collapsed, created_at, updated_at)" +
      " VALUES ('uid_q1', 1, 'uid_b1', 0, 'under b1', NULL, 0, 1, 1)");
    enqueueBatch(t.db, [
      { op: "create", uid: uid("uid_new1"), page_title: "Machine Learning",
        parent_uid: uid("uid_b2"), order_idx: ord(1), text: "typed child" },
    ], 5, bid("batch-create"));
    enqueueBatch(t.db, [
      { op: "move", uid: uid("uid_new1"), parent_uid: uid("uid_b1"), order_idx: ord(0) },
    ], 5, bid("batch-move"));
    const settled = [
      { uid: "uid_new1", page_id: 1, parent_uid: "uid_b1", order_idx: 0 },
      { uid: "uid_q1", page_id: 1, parent_uid: "uid_b1", order_idx: 1 },
    ];
    const underB1 = () => tree().filter((r) => r.parent_uid === "uid_b1");
    expect(underB1()).toEqual(settled);

    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      blocks: [block("uid_b2", 2), block("uid_b3", 2, { parent_uid: uid("uid_b2") })],
    }), 6);
    applyChanges(t.db, emptyFeed({
      next_since: 12, latest_seq: 12,
      blocks: [block("uid_b3", 2, { parent_uid: uid("uid_b2"), text: "edited" })],
    }), 7);

    expect(underB1()).toEqual(settled);
  });
});

describe("applyChanges: a window that names a pending batch as applied drops it instead of replaying it", () => {
  // s1..s6 at 0..5 on one page: the shape the sync property found this on.
  const SIX: Snapshot = {
    generation: "gen-1", plain_space_title_canonicalization: false,
    seq: 10 as SyncSeq, pages: [page(1, "P")],
    blocks: ["s1", "s2", "s3", "s4", "s5", "s6"].map(
      (u, i) => block(u, 1, { order_idx: ord(i) })),
    sidebar: [],
  };
  const mv = (u: string, o: number): BlockOp =>
    ({ op: "move", uid: uid(u), parent_uid: null, order_idx: ord(o) });
  const cr = (u: string, o: number): BlockOp =>
    ({ op: "create", uid: uid(u), page_title: "P", parent_uid: null,
       order_idx: ord(o), text: `text of ${u}` });
  const ut = (u: string, text: string): BlockOp =>
    ({ op: "update_text", uid: uid(u), text });
  type Row = { uid: string; parent_uid: string | null; order_idx: number; text: string };
  const rows = (db: ReplicaDb): Row[] => db.select<Row>(
    "SELECT uid, parent_uid, order_idx, text FROM blocks ORDER BY uid");
  const asSync = (db: ReplicaDb, keep: (u: string) => boolean = () => true): SyncBlock[] =>
    rows(db).filter((r) => keep(r.uid)).map((r) => block(r.uid, 1, {
      parent_uid: r.parent_uid as BlockUid | null, order_idx: ord(r.order_idx),
      text: r.text }));
  const named = (batchId: string, seq = 11) =>
    ({ batch_id: bid(batchId), seq: seq as SyncSeq, skipped: [] });

  /** The server's rows: the batch applied for real, then `later` (another
   * device's edits) on top. */
  const serverAfter = async (batch: BlockOp[], later: BlockOp[] = []): Promise<TestDb> => {
    const s = await openTestDb();
    applySnapshot(s.db, SIX, 1);
    applyLocalOps(s.db, batch, 2, { batchId: bid("t") });
    if (later.length > 0) applyLocalOps(s.db, later, 3, { batchId: bid("t") });
    return s;
  };

  const cases: [string, BlockOp[], BlockOp[]][] = [
    ["two moves of one block", [mv("s4", 0), mv("s4", 1)], []],
    ["moves of two blocks", [mv("s4", 0), mv("s5", 0)], []],
    ["a move then a create", [mv("s4", 0), cr("n1", 0)], []],
    ["an update another device superseded", [ut("s1", "mine")], [ut("s1", "theirs")]],
  ];
  for (const [name, batch, later] of cases) {
    test(name, async () => {
      const srv = await serverAfter(batch, later);
      applySnapshot(t.db, SIX, 1);
      enqueueBatch(t.db, batch, 3, bid("b0"));
      const [row] = allBatches(t.db);

      const res = applyChanges(t.db, emptyFeed({
        next_since: 11, latest_seq: 11, blocks: asSync(srv.db),
        applied_batches: [named("b0")],
      }), 4);

      expect(res).toEqual({
        status: "applied", cursor: 11,
        dropped: [{ id: row.id, batch_id: bid("b0"), seq: 11, skipped: [] }],
      });
      expect(allBatches(t.db)).toEqual([]);
      expect(rows(t.db)).toEqual(rows(srv.db));
      applyChanges(t.db, emptyFeed({ next_since: 12, latest_seq: 12 }), 5);
      expect(rows(t.db)).toEqual(rows(srv.db));
      srv.close();
    });
  }

  test("a partial window shipping only the siblings", async () => {
    const batch = [mv("s4", 0), mv("s4", 1)];
    const srv = await serverAfter(batch);
    applySnapshot(t.db, SIX, 1);
    enqueueBatch(t.db, batch, 3, bid("b0"));

    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 12, blocks: asSync(srv.db, (u) => u !== "s4"),
      applied_batches: [named("b0")],
    }), 4);
    const others = (rs: Row[]) => rs.filter((r) => r.uid !== "s4");
    expect(allBatches(t.db)).toEqual([]);
    expect(others(rows(t.db))).toEqual(others(rows(srv.db)));

    // the rest of the batch's journal rows, in the next window
    applyChanges(t.db, emptyFeed({
      next_since: 12, latest_seq: 12, blocks: asSync(srv.db, (u) => u === "s4"),
    }), 5);
    expect(rows(t.db)).toEqual(rows(srv.db));
    srv.close();
  });

  test("the same window not naming the batch still replays it", async () => {
    const batch = [mv("s4", 0), mv("s4", 1)];
    const srv = await serverAfter(batch);
    applySnapshot(t.db, SIX, 1);
    enqueueBatch(t.db, batch, 3, bid("b0"));

    const res = applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11, blocks: asSync(srv.db),
    }), 4);

    expect(res).toEqual({ status: "applied", cursor: 11 });
    expect(allBatches(t.db).map((b) => b.batch_id)).toEqual([bid("b0")]);
    expect(rows(t.db)).not.toEqual(rows(srv.db));
    srv.close();
  });

  test("only named rows go, and only rows the caller lets it drop", () => {
    applySnapshot(t.db, SIX, 1);
    enqueueBatch(t.db, [mv("s4", 0)], 3, bid("b0"));
    enqueueBatch(t.db, [mv("s5", 0)], 3, bid("b1"));
    enqueueBatch(t.db, [mv("s6", 0)], 3, bid("b2"));
    const [b0, b1, b2] = allBatches(t.db);

    const res = applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11,
      applied_batches: [named("b0"), named("b1"), named("never-queued")],
    }), 4, { droppable: [b0.id, b2.id] });

    expect(res).toEqual({
      status: "applied", cursor: 11,
      dropped: [{ id: b0.id, batch_id: bid("b0"), seq: 11, skipped: [] }],
    });
    expect(allBatches(t.db).map((b) => b.id)).toEqual([b1.id, b2.id]);
  });

  test("a poisoned row is never dropped", () => {
    applySnapshot(t.db, SIX, 1);
    enqueueBatch(t.db, [mv("s4", 0)], 3, bid("b0"));
    const [b0] = allBatches(t.db);
    markPoisoned(t.db, b0.id, "rejected", bid("b0"));

    const res = applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11, applied_batches: [named("b0")],
    }), 4);

    expect(res).toEqual({ status: "applied", cursor: 11 });
    expect(allBatches(t.db).map((b) => b.id)).toEqual([b0.id]);
  });

  test("a window that rolls back keeps the named rows", () => {
    applySnapshot(t.db, SIX, 1);
    enqueueBatch(t.db, [mv("s4", 0)], 3, bid("b0"));

    const res = applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11, applied_batches: [named("b0")],
      // a block on a page nothing ships: the deferred FK fails at COMMIT
      blocks: [block("orphan", 99)],
    }), 4);

    expect(res).toEqual({ status: "needs-bootstrap" });
    expect(allBatches(t.db).map((b) => b.batch_id)).toEqual([bid("b0")]);
  });

  test("applySnapshot drops a named batch before its replay", async () => {
    const batch = [mv("s4", 0), mv("s4", 1)];
    const srv = await serverAfter(batch);
    applySnapshot(t.db, SIX, 1);
    enqueueBatch(t.db, batch, 3, bid("b0"));
    enqueueBatch(t.db, [mv("s6", 0)], 3, bid("b1"));
    const [b0] = allBatches(t.db);

    const dropped = applySnapshot(t.db, {
      ...SIX, seq: 11 as SyncSeq, blocks: asSync(srv.db),
      applied_batches: [named("b0")],
    }, 4);

    expect(dropped).toEqual([{ id: b0.id, batch_id: bid("b0"), seq: 11, skipped: [] }]);
    expect(allBatches(t.db).map((b) => b.batch_id)).toEqual([bid("b1")]);
    // b1 still replays over the server's rows: s6 to the front
    const replica = rows(t.db);
    expect(replica.find((r) => r.uid === "s6")?.order_idx).toBe(0);
    srv.close();
  });
});

describe("applyChanges: the effect ledger", () => {
  // P holds m@0 a@1 r@2; S holds s@0. Pages are top-level groups here, so
  // `keys` reads one page's top level in order.
  const LEDGER_SNAP: Snapshot = {
    generation: "gen-1", plain_space_title_canonicalization: false,
    seq: 10 as SyncSeq, pages: [page(1, "P"), page(2, "S")],
    blocks: [block("m", 1, { order_idx: ord(0) }),
             block("a", 1, { order_idx: ord(1) }),
             block("r", 1, { order_idx: ord(2) }),
             block("s", 2, { order_idx: ord(0) })],
    sidebar: [],
  };
  beforeEach(() => { applySnapshot(t.db, LEDGER_SNAP, 1); });

  type Rec = { batch_id: string; uid: string; order_delta: number;
               base_page_id: number | null; base_updated_at: number | null };
  const ledger = (): Rec[] => t.db.select<Rec>(
    "SELECT batch_id, uid, order_delta, base_page_id, base_updated_at" +
    " FROM effect_ledger ORDER BY batch_id, uid");
  /** `uid:delta` per record, in (batch, uid) order. */
  const deltas = (): string[] =>
    ledger().map((r) => `${r.batch_id}:${r.uid}${r.order_delta}`);
  /** A page's top level as `uid` + `order_idx`, in order. */
  const keys = (rawPageId: number): string =>
    t.db.select<{ uid: string; order_idx: number }>(
      "SELECT uid, order_idx FROM blocks WHERE page_id = ? AND parent_uid IS NULL" +
      " ORDER BY order_idx, uid", [rawPageId])
      .map((r) => `${r.uid}${r.order_idx}`).join(" ");

  const createTop = (u: string, o: number, pageTitle = "P"): BlockOp =>
    ({ op: "create", uid: uid(u), page_title: pageTitle, parent_uid: null,
       order_idx: ord(o), text: `text of ${u}` });
  // An untitled top-level move stays on the page the replica sees the
  // block on.
  const moveTop = (u: string, o: number): BlockOp =>
    ({ op: "move", uid: uid(u), parent_uid: null, order_idx: ord(o) });
  const named = (batchId: string) =>
    ({ batch_id: bid(batchId), seq: 11 as SyncSeq, skipped: [] });

  // Another device moved m to S (after s) before this replica pulled: the
  // server's move of m shifts S's top level, where nothing sits past s.
  const M_ON_S = block("m", 2, { order_idx: ord(1) });

  test("a window upsert drops records on the shipped block", () => {
    enqueueBatch(t.db, [createTop("X", 0)], 2, bid("b1"));
    expect(deltas()).toEqual(["b1:a1", "b1:m1", "b1:r1"]);

    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11, blocks: [block("a", 1, { order_idx: ord(1) })],
    }), 3);

    expect(deltas()).toEqual(["b1:m1", "b1:r1"]);
  });

  test("a block tombstone drops records, applied at the head and deferred short of it", () => {
    enqueueBatch(t.db, [createTop("X", 0)], 2, bid("b1"));

    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 12,
      tombstones: [{ kind: "block", entity_id: "a" }],
    }), 3);
    expect(keys(1)).toContain("a2"); // the tombstone waits for the head
    expect(deltas()).toEqual(["b1:m1", "b1:r1"]);

    applyChanges(t.db, emptyFeed({
      next_since: 12, latest_seq: 12,
      tombstones: [{ kind: "block", entity_id: "r" }],
    }), 4);
    expect(keys(1)).toBe("X0 m1");
    expect(deltas()).toEqual(["b1:m1"]);
  });

  test("no revert while the batch is pending", () => {
    enqueueBatch(t.db, [moveTop("m", 1)], 2, bid("b1"));
    expect(keys(1)).toBe("m1 a2 r3");

    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11, blocks: [M_ON_S],
    }), 3);

    expect(keys(1)).toBe("a2 r3");
    expect(deltas()).toEqual(["b1:a1", "b1:r1"]);
  });

  test("no revert in a window short of the head after the ack; revert in the next head window", () => {
    enqueueBatch(t.db, [moveTop("m", 1)], 2, bid("b1"));
    ackNext(t.db);

    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 12, blocks: [M_ON_S],
    }), 3);
    expect(keys(1)).toBe("a2 r3");
    expect(deltas()).toEqual(["b1:a1", "b1:r1"]);

    applyChanges(t.db, emptyFeed({ next_since: 12, latest_seq: 12 }), 4);
    expect(keys(1)).toBe("a1 r2");
    expect(keys(2)).toBe("s0 m1");
    expect(ledger()).toEqual([]);
  });

  test("revert at an empty head window after deleteBatch", () => {
    enqueueBatch(t.db, [moveTop("m", 1)], 2, bid("b1"));
    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11, blocks: [M_ON_S],
    }), 3);
    ackNext(t.db);

    applyChanges(t.db, emptyFeed({ next_since: 12, latest_seq: 12 }), 4);

    expect(keys(1)).toBe("a1 r2");
    expect(ledger()).toEqual([]);
  });

  test("revert in the window whose applied_batches names the batch, before the replay", () => {
    enqueueBatch(t.db, [moveTop("m", 1)], 2, bid("b1"));
    enqueueBatch(t.db, [createTop("X", 3)], 2, bid("b2"));
    expect(keys(1)).toBe("m1 a2 X3 r4");

    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11, blocks: [M_ON_S],
      applied_batches: [named("b1")],
    }), 3);

    // b1 reverted first, so b2's replay found r on X's slot and moved it on
    expect(allBatches(t.db).map((b) => b.batch_id)).toEqual([bid("b2")]);
    expect(keys(1)).toBe("a1 X3 r4");
    expect(deltas()).toEqual(["b2:r2"]);
  });

  test("a poisoned batch never settles", () => {
    enqueueBatch(t.db, [moveTop("m", 1)], 2, bid("b1"));
    const [b1] = allBatches(t.db);
    markPoisoned(t.db, b1.id, "rejected", bid("b1"));

    applyChanges(t.db, emptyFeed({ next_since: 11, latest_seq: 11 }), 3);

    expect(keys(1)).toBe("m1 a2 r3");
    expect(deltas()).toEqual(["b1:a1", "b1:r1"]);
  });

  test("two pending batches: the spec's table, row by row", () => {
    enqueueBatch(t.db, [moveTop("m", 1)], 2, bid("b1"));
    expect(keys(1)).toBe("m1 a2 r3");
    expect(deltas()).toEqual(["b1:a1", "b1:r1"]);

    enqueueBatch(t.db, [createTop("X", 3)], 2, bid("b2"));
    expect(keys(1)).toBe("m1 a2 X3 r4");
    expect(deltas()).toEqual(["b1:a1", "b1:r1", "b2:r1"]);

    // b1 commits: the server moves m on S
    ackNext(t.db);
    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11, blocks: [M_ON_S],
    }), 3);
    expect(keys(1)).toBe("a1 X3 r4");
    expect(deltas()).toEqual(["b2:r2"]);

    // b2 commits: X at 3, with r@2 below the slot
    ackNext(t.db);
    applyChanges(t.db, emptyFeed({
      next_since: 12, latest_seq: 12,
      blocks: [block("X", 1, { order_idx: ord(3), text: "text of X" })],
    }), 4);
    expect(keys(1)).toBe("a1 r2 X3");
    expect(ledger()).toEqual([]);
  });

  describe("a batch rolled back in reapplyPending leaves only its earlier records", () => {
    test("an op that throws", () => {
      enqueueBatch(t.db, [createTop("X", 0),
                          { op: "update_text", uid: uid("X"), text: "later" }],
                   2, bid("b1"));
      expect(deltas()).toEqual(["b1:a1", "b1:m1", "b1:r1"]);
      // The replay's update_text fails after its create recorded a shift.
      t.db.exec("CREATE TEMP TRIGGER fail_x_text BEFORE UPDATE OF text ON blocks" +
                " WHEN NEW.uid = 'X' BEGIN SELECT RAISE(ABORT, 'refused'); END");

      // another device's z on X's slot: the replay's keepSlot shifts past it
      const res = applyChanges(t.db, emptyFeed({
        next_since: 11, latest_seq: 11, blocks: [block("z", 1, { order_idx: ord(0) })],
      }), 3);

      expect(res).toEqual({ status: "applied", cursor: 11 });
      expect(keys(1)).toBe("X0 z0 m1 a2 r3");
      expect(deltas()).toEqual(["b1:a1", "b1:m1", "b1:r1"]);
    });

    test("an op that adds an FK violation", () => {
      // Q@0 top-level on P with child C@0.
      applySnapshot(t.db, {
        ...LEDGER_SNAP,
        blocks: [block("Q", 1), block("C", 1, { parent_uid: uid("Q") })],
      }, 1);
      enqueueBatch(t.db, [
        { op: "create", uid: uid("X"), page_title: "P", parent_uid: uid("Q"),
          order_idx: ord(0), text: "x" },
        { op: "create", uid: uid("Y"), page_title: "P", parent_uid: uid("X"),
          order_idx: ord(0), text: "y" },
      ], 2, bid("b1"));
      enqueueBatch(t.db, [
        { op: "move", uid: uid("Q"), parent_uid: null, page_title: "P",
          order_idx: ord(0) },
      ], 2, bid("b2"));
      expect(deltas()).toEqual(["b1:C1"]);

      // Q arrives on a page the window never ships. b1's replay follows Q
      // there, re-paging Y (a record) and leaving X and Y dangling, so it
      // rolls back; b2's replay moves Q back onto P and the COMMIT holds.
      const res = applyChanges(t.db, emptyFeed({
        next_since: 11, latest_seq: 11, blocks: [block("Q", 99)],
      }), 3);

      expect(res).toEqual({ status: "applied", cursor: 11 });
      expect(ledger().filter((r) => r.batch_id === "b1"))
        .toEqual([{ batch_id: "b1", uid: "C", order_delta: 1,
                    base_page_id: null, base_updated_at: null }]);
    });
  });

  test("applySnapshot clears the ledger and its replay records again", () => {
    enqueueBatch(t.db, [moveTop("m", 1)], 2, bid("b0"));
    ackNext(t.db); // awaiting its head window
    enqueueBatch(t.db, [createTop("X", 0)], 2, bid("b1"));
    expect(deltas()).toEqual(["b0:a1", "b0:r1", "b1:a1", "b1:m1", "b1:r1"]);

    applySnapshot(t.db, { ...LEDGER_SNAP, seq: 11 as SyncSeq }, 3);

    expect(keys(1)).toBe("X0 m1 a2 r3");
    expect(deltas()).toEqual(["b1:a1", "b1:m1", "b1:r1"]);
  });

  test("a window that rolls back (StaleTitleHolderError) leaves the ledger as it was", () => {
    enqueueBatch(t.db, [moveTop("m", 1)], 2, bid("b1"));
    ackNext(t.db);

    // page 5 takes P's title; nothing retitles or deletes page 1
    const res = applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11, pages: [page(5, "P")],
      blocks: [block("a", 1, { order_idx: ord(1) })],
    }), 3);

    expect(res).toEqual({ status: "needs-bootstrap" });
    expect(keys(1)).toBe("m1 a2 r3");
    expect(deltas()).toEqual(["b1:a1", "b1:r1"]);
  });

  test("a batch replayed over its own echo reverts at settle", async () => {
    // The server applies the batch to the same group: r1 m2 a3.
    const batch = [moveTop("r", 0), moveTop("r", 1)];
    const srv = await openTestDb();
    applySnapshot(srv.db, LEDGER_SNAP, 1);
    applyLocalOps(srv.db, batch, 2, { batchId: bid("srv") });
    const serverRows = (db: ReplicaDb) => db.select(
      "SELECT uid, page_id, parent_uid, order_idx FROM blocks ORDER BY uid");
    const echo = srv.db.select<{ uid: string; order_idx: number }>(
      "SELECT uid, order_idx FROM blocks WHERE page_id = 1")
      .map((r) => block(r.uid, 1, { order_idx: ord(r.order_idx) }));
    enqueueBatch(t.db, batch, 2, bid("b1"));

    // the echo, not naming the batch: the replay runs over it and shifts again
    applyChanges(t.db, emptyFeed({ next_since: 11, latest_seq: 11, blocks: echo }), 3);
    expect(keys(1)).toBe("r1 m4 a5");
    expect(deltas()).toEqual(["b1:a2", "b1:m2"]);

    ackNext(t.db);
    applyChanges(t.db, emptyFeed({ next_since: 12, latest_seq: 12 }), 4);

    expect(serverRows(t.db)).toEqual(serverRows(srv.db));
    expect(ledger()).toEqual([]);
    srv.close();
  });

  test("a base on a local page lands on the server's id when the page arrives in the settling window", () => {
    // B and its child D are made on a new title, then B moves to P: D's
    // record names the local page as its base.
    enqueueBatch(t.db, [
      createTop("B", 0, "Local"),
      { op: "create", uid: uid("D"), page_title: "Local", parent_uid: uid("B"),
        order_idx: ord(0), text: "d" },
      { op: "move", uid: uid("B"), parent_uid: null, page_title: "P",
        order_idx: ord(0) },
    ], 2, bid("b1"));
    const [local] = t.db.select<{ id: number }>(
      "SELECT id FROM pages WHERE title = 'Local'");
    expect(local.id).toBeLessThan(0);
    expect(ledger()).toContainEqual(
      { batch_id: "b1", uid: "D", order_delta: 0, base_page_id: local.id,
        base_updated_at: 2 });

    ackNext(t.db);
    applyChanges(t.db, emptyFeed({
      next_since: 11, latest_seq: 11, pages: [page(7, "Local")],
    }), 3);

    expect(t.db.select("SELECT page_id FROM blocks WHERE uid = 'D'"))
      .toEqual([{ page_id: 7 }]);
    expect(ledger()).toEqual([]);
  });
});

describe("applyChanges: a create or move the two sides place in different groups", () => {
  // Each test seeds the replica, enqueues the batch, acks it, then applies
  // the head window with the rows the server wrote. The rows the server
  // never wrote are never re-shipped, so the settle must put them back.
  // The server leaves a gap in the group a block leaves.
  const seed = (pages: ReturnType<typeof page>[], blocks: SyncBlock[]): void => {
    applySnapshot(t.db, {
      generation: "gen-1", plain_space_title_canonicalization: false,
      seq: 10 as SyncSeq, pages, blocks, sidebar: [],
    }, 1);
  };
  const at = (rawUid: string, rawPageId: number, o: number,
              over: Partial<SyncBlock> = {}): SyncBlock =>
    block(rawUid, rawPageId, { order_idx: ord(o), ...over });
  /** One sibling group as `uid@order_idx`, in order. */
  const group = (rawPageId: number, parent: string | null = null): string =>
    t.db.select<{ uid: string; order_idx: number }>(
      "SELECT uid, order_idx FROM blocks WHERE page_id = ? AND parent_uid IS ?" +
      " ORDER BY order_idx, uid", [rawPageId, parent])
      .map((r) => `${r.uid}@${r.order_idx}`).join(" ");
  const titles = (): Array<{ id: number; title: string }> =>
    t.db.select("SELECT id, title FROM pages ORDER BY id");
  const ledgerRows = (): number => count("SELECT COUNT(*) AS n FROM effect_ledger");

  const enqueueAndAck = (ops: BlockOp[]): void => {
    enqueueBatch(t.db, ops, 2, bid("b1"));
    ackNext(t.db);
  };
  const headWindow = (over: Parameters<typeof emptyFeed>[0]): void => {
    expect(applyChanges(t.db, emptyFeed({ next_since: 11, latest_seq: 11, ...over }), 3))
      .toEqual({ status: "applied", cursor: 11 });
  };

  const moveTop = (u: string, o: number, pageTitle?: string): BlockOp =>
    ({ op: "move", uid: uid(u), parent_uid: null, order_idx: ord(o),
       ...(pageTitle !== undefined ? { page_title: pageTitle } : {}) });
  const moveUnder = (u: string, parent: string, o: number): BlockOp =>
    ({ op: "move", uid: uid(u), parent_uid: uid(parent), order_idx: ord(o) });

  test("an untitled top-level move of a block moved to another page elsewhere", () => {
    // The server already has m at the top of S (x shifted to 1).
    seed([page(1, "P"), page(2, "S")],
         [at("m", 1, 0), at("a", 1, 1), at("r", 1, 2), at("x", 2, 0)]);
    enqueueAndAck([moveTop("m", 1)]);
    expect(group(1)).toBe("m@1 a@2 r@3");

    // The server moves m on S, where it is, shifting x past it.
    headWindow({ blocks: [at("m", 2, 1), at("x", 2, 2)] });

    expect(group(1)).toBe("a@1 r@2");
    expect(group(2)).toBe("m@1 x@2");
    expect(ledgerRows()).toBe(0);
  });

  // The server's page 1 was renamed Third; the replica still calls it
  // Proptest, so the op's title resolves to page 1 here and to a fresh
  // page 3 on the server.
  const seedRenamed = (): void => {
    seed([page(1, "Proptest"), page(2, "Second")],
         [at("s1", 1, 0), at("s2", 1, 1), at("s3", 1, 2)]);
  };
  const RENAMED_PAGES = [page(1, "Third"), page(3, "Proptest")];

  test("a top-level move to a title renamed away before the pull", () => {
    seedRenamed();
    enqueueAndAck([moveTop("s3", 0, "Proptest")]);
    expect(group(1)).toBe("s3@0 s1@1 s2@2");

    headWindow({ pages: RENAMED_PAGES, blocks: [at("s3", 3, 0)] });

    expect(titles()).toEqual([{ id: 1, title: "Third" }, { id: 2, title: "Second" },
                              { id: 3, title: "Proptest" }]);
    expect(group(1)).toBe("s1@0 s2@1");
    expect(group(3)).toBe("s3@0");
    expect(ledgerRows()).toBe(0);
  });

  test("a top-level create on a title renamed away before the pull", () => {
    seedRenamed();
    enqueueAndAck([{ op: "create", uid: uid("X"), page_title: "Proptest",
                     parent_uid: null, order_idx: ord(0), text: "text of X" }]);
    expect(group(1)).toBe("X@0 s1@1 s2@2 s3@3");

    headWindow({ pages: RENAMED_PAGES, blocks: [at("X", 3, 0)] });

    expect(titles()).toEqual([{ id: 1, title: "Third" }, { id: 2, title: "Second" },
                              { id: 3, title: "Proptest" }]);
    expect(group(1)).toBe("s1@0 s2@1 s3@2");
    expect(group(3)).toBe("X@0");
    expect(ledgerRows()).toBe(0);
  });

  test("an untitled top-level move of a block moved across pages and deleted elsewhere", () => {
    // On the server, m went to the top of S (x shifted to 1) and was deleted.
    seed([page(1, "P"), page(2, "S")],
         [at("a", 1, 0), at("m", 1, 1), at("r", 1, 2), at("x", 2, 0)]);
    enqueueAndAck([moveTop("m", 0)]);
    expect(group(1)).toBe("m@0 a@1 r@3");

    // The server skips the move and re-journals the top level of S, the
    // page m's delete row names.
    headWindow({ blocks: [at("x", 2, 1)],
                 tombstones: [{ kind: "block", entity_id: "m" }] });

    expect(group(1)).toBe("a@0 r@2");
    expect(group(2)).toBe("x@1");
    expect(ledgerRows()).toBe(0);
  });

  test("an untitled top-level move after a move to another page, of a block deleted elsewhere", () => {
    seed([page(1, "P"), page(2, "S")],
         [at("m", 1, 0), at("a", 1, 1), at("x", 2, 0), at("y", 2, 1)]);
    enqueueAndAck([moveUnder("m", "x", 0), moveTop("m", 0)]);
    expect(group(2)).toBe("m@0 x@1 y@2");

    // The server skips both moves; the second re-journals P's top level,
    // where m was deleted.
    headWindow({ blocks: [at("a", 1, 1)],
                 tombstones: [{ kind: "block", entity_id: "m" }] });

    expect(group(1)).toBe("a@1");
    expect(group(2)).toBe("x@0 y@1");
    expect(ledgerRows()).toBe(0);
  });

  test("an untitled top-level move after the batch's own move under a parent deleted elsewhere", () => {
    seed([page(1, "P"), page(2, "S")],
         [at("a", 1, 0), at("m", 1, 1), at("r", 1, 2),
          at("x", 2, 0), at("y", 2, 1), at("z", 2, 2)]);
    enqueueAndAck([moveUnder("m", "y", 0), moveTop("m", 0)]);
    expect(group(1)).toBe("a@0 r@2");
    expect(group(2)).toBe("m@0 x@1 y@2 z@3");

    // The server skips the move under the gone y, so the second move finds
    // m still on P and shifts P.
    headWindow({ blocks: [at("m", 1, 0), at("a", 1, 1), at("r", 1, 3)],
                 tombstones: [{ kind: "block", entity_id: "y" }] });

    expect(group(1)).toBe("m@0 a@1 r@3");
    expect(group(2)).toBe("x@0 z@2");
    expect(ledgerRows()).toBe(0);
  });

  test("a move under a parent another device moved to the block's own page", () => {
    // The server already has t1 at the top of P (s1 shifted to 1).
    seed([page(1, "P"), page(2, "S")],
         [at("s1", 1, 0), at("s2", 1, 0, { parent_uid: uid("s1"), updated_at: 5 }),
          at("t1", 2, 0), at("t2", 2, 1)]);
    enqueueAndAck([moveUnder("s1", "t1", 0)]);
    expect(t.db.select("SELECT page_id FROM blocks WHERE uid IN ('s1', 's2')"))
      .toEqual([{ page_id: 2 }, { page_id: 2 }]);

    // s1 stays on P under t1: the server re-pages nothing.
    headWindow({ blocks: [at("t1", 1, 0), at("s1", 1, 0, { parent_uid: uid("t1") })] });

    expect(t.db.select(
      "SELECT uid, page_id, parent_uid, updated_at FROM blocks" +
      " WHERE uid = 's2'"))
      .toEqual([{ uid: "s2", page_id: 1, parent_uid: "s1", updated_at: 5 }]);
    expect(group(1)).toBe("t1@0");
    expect(group(1, "t1")).toBe("s1@0");
    expect(group(2)).toBe("t2@1");
    expect(ledgerRows()).toBe(0);
  });
});
