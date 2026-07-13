// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type { Changes, Snapshot, SyncBlock } from "./apply";
import { applyChanges, applySnapshot } from "./apply";
import { getMeta } from "./meta";
import { openTestDb, type TestDb } from "./testDb";

const block = (uid: string, pageId: number, over: Partial<SyncBlock> = {}): SyncBlock => ({
  uid, page_id: pageId, parent_uid: null, order_idx: 0, text: `text of ${uid}`,
  heading: null, collapsed: 0, created_at: 1, updated_at: 1, refs: [], ...over,
});

const page = (id: number, title: string) =>
  ({ id, title, created_at: 1, updated_at: 1 });

const SNAP: Snapshot = {
  generation: "gen-1", seq: 10,
  pages: [page(1, "Machine Learning"), page(2, "AI")],
  blocks: [
    block("uid_b1", 1, { text: "links [[AI]]", refs: [{ target_page_id: 2, kind: "link" }] }),
    block("uid_b2", 1, { order_idx: 1 }),
    block("uid_b3", 1, { parent_uid: "uid_b2", text: "child block searchable" }),
  ],
  sidebar: [{ id: 1, title: "AI", order_idx: 0 }],
};

const emptyFeed = (over: Partial<Changes> = {}): Changes => ({
  reset: false, generation: "gen-1", next_since: 10, latest_seq: 10,
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

  test("re-bootstrap wipes stale rows first", () => {
    applySnapshot(t.db, {
      generation: "gen-2", seq: 4,
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
});

describe("applyChanges", () => {
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

  test("a generation flip requests a re-bootstrap (rebuilt database)", () => {
    const feed = emptyFeed({ generation: "gen-2" });
    expect(applyChanges(t.db, feed)).toEqual({ status: "needs-bootstrap" });
    expect(getMeta(t.db, "cursor")).toBe("10"); // untouched
  });

  test("an empty feed just advances the cursor", () => {
    expect(applyChanges(t.db, emptyFeed({ next_since: 11, latest_seq: 11 })))
      .toEqual({ status: "applied", cursor: 11 });
    expect(getMeta(t.db, "cursor")).toBe("11");
  });
});
