// @vitest-environment node
// Negative-id page reconciliation (spec section 3): when the feed delivers
// the authoritative row for a page created offline, children and refs are
// remapped inside the window transaction — never a cascade delete.
import { beforeEach, describe, expect, test } from "vitest";
import { applyChanges, type Changes } from "./apply";
import { applyLocalOps } from "./localOps";
import { setMeta } from "./meta";
import { openTestDb, type TestDb } from "./testDb";

let t: TestDb;
let negId: number;
beforeEach(async () => {
  t?.close();
  t = await openTestDb();
  setMeta(t.db, "generation", "gen-1");
  setMeta(t.db, "cursor", "10");
  t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'AI')");
  // offline: create a page implicitly (via a link) and explicitly add a block
  applyLocalOps(t.db, [
    { op: "create", uid: "uid_l1", page_title: "Offline Page", parent_uid: null,
      order_idx: 0, text: "links back to [[AI]]" },
    { op: "create", uid: "uid_l2", page_title: "Offline Page", parent_uid: "uid_l1",
      order_idx: 0, text: "a child" },
  ], 50);
  negId = t.db.select<{ id: number }>(
    "SELECT id FROM pages WHERE title = 'Offline Page'")[0].id;
  expect(negId).toBeLessThan(0);
});

const feed = (over: Partial<Changes>): Changes => ({
  reset: false, generation: "gen-1", next_since: 11, latest_seq: 11,
  pages: [], blocks: [], sidebar: [], tombstones: [], ...over,
});

describe("reconcile on feed page delivery", () => {
  test("remaps children and refs to the authoritative id, no cascade", () => {
    // simulate: another block on AI refs the offline page (negative target)
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('uid_a1', 1, NULL, 0, 'see [[Offline Page]]')");
    t.db.exec("INSERT INTO refs VALUES ('uid_a1', ?, 'link')", [negId]);

    applyChanges(t.db, feed({
      pages: [{ id: 7, title: "Offline Page", created_at: 9, updated_at: 9 }],
    }));
    // negative row replaced by the authoritative one
    expect(t.db.select("SELECT id FROM pages WHERE title = 'Offline Page'"))
      .toEqual([{ id: 7 }]);
    // local-only blocks (feed hasn't delivered them yet) survived, remapped
    expect(t.db.select(
      "SELECT uid FROM blocks WHERE page_id = 7 ORDER BY uid"))
      .toEqual([{ uid: "uid_l1" }, { uid: "uid_l2" }]);
    // inbound ref follows
    expect(t.db.select(
      "SELECT target_page_id FROM refs WHERE src_block_uid = 'uid_a1'"))
      .toEqual([{ target_page_id: 7 }]);
  });

  test("a colliding ref (block already refs the authoritative id) merges", () => {
    t.db.exec("INSERT INTO pages(id, title) VALUES (7, 'Placeholder')");
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('uid_a1', 1, NULL, 0, 'refs both')");
    t.db.exec("INSERT INTO refs VALUES ('uid_a1', 7, 'link')");
    t.db.exec("INSERT INTO refs VALUES ('uid_a1', ?, 'link')", [negId]);
    applyChanges(t.db, feed({
      pages: [{ id: 7, title: "Offline Page", created_at: 9, updated_at: 9 }],
    }));
    expect(t.db.select(
      "SELECT COUNT(*) AS n FROM refs WHERE src_block_uid = 'uid_a1'" +
      " AND target_page_id = 7")).toEqual([{ n: 1 }]);
  });

  test("positive-id pages upsert without reconcile side effects", () => {
    applyChanges(t.db, feed({
      pages: [{ id: 1, title: "AI", created_at: 2, updated_at: 2 }],
    }));
    expect(t.db.select("SELECT COUNT(*) AS n FROM pages WHERE id < 0"))
      .toEqual([{ n: 1 }]); // untouched offline page still negative
  });
});
