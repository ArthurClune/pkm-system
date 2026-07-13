// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import { applyLocalOps, getOrCreateLocalPage } from "./localOps";
import { openTestDb, type TestDb } from "./testDb";

let t: TestDb;
beforeEach(async () => {
  t?.close();
  t = await openTestDb();
  t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'AI'), (2, 'ML')");
  t.db.exec(
    "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text) VALUES" +
    " ('uid_r1', 1, NULL, 0, 'first')," +
    " ('uid_r2', 1, NULL, 1, 'second')," +
    " ('uid_r2c', 1, 'uid_r2', 0, 'child of second')");
});

const rows = <T>(sql: string): T[] => t.db.select<T>(sql);
const blockRow = (uid: string) =>
  rows<{ page_id: number; parent_uid: string | null; order_idx: number;
         text: string; collapsed: number; heading: number | null }>(
    `SELECT page_id, parent_uid, order_idx, text, collapsed, heading
     FROM blocks WHERE uid = '${uid}'`)[0];

describe("getOrCreateLocalPage", () => {
  test("returns existing pages and mints distinct negative ids for new ones", () => {
    expect(getOrCreateLocalPage(t.db, "AI", 5)).toBe(1);
    const p1 = getOrCreateLocalPage(t.db, "Offline One", 5);
    const p2 = getOrCreateLocalPage(t.db, "Offline Two", 5);
    expect(p1).toBeLessThan(0);
    expect(p2).toBeLessThan(0);
    expect(p1).not.toBe(p2);
    expect(getOrCreateLocalPage(t.db, "Offline One", 9)).toBe(p1);
  });
});

describe("applyLocalOps", () => {
  test("create shifts following siblings and reindexes refs", () => {
    applyLocalOps(t.db, [{
      op: "create", uid: "uid_new1", page_title: "AI", parent_uid: null,
      order_idx: 1, text: "links [[ML]] and [[Brand New]]",
    }], 99);
    expect(blockRow("uid_new1").order_idx).toBe(1);
    expect(blockRow("uid_r2").order_idx).toBe(2); // shifted
    expect(blockRow("uid_r1").order_idx).toBe(0); // untouched
    const refs = rows<{ target_page_id: number }>(
      "SELECT target_page_id FROM refs WHERE src_block_uid = 'uid_new1'");
    expect(refs.length).toBe(2);
    // the implicit page got a negative id and the ref points at it
    const brandNew = rows<{ id: number }>(
      "SELECT id FROM pages WHERE title = 'Brand New'")[0];
    expect(brandNew.id).toBeLessThan(0);
    expect(refs.map((r) => r.target_page_id)).toContain(brandNew.id);
  });

  test("update_text rewrites text and refs; FTS sees the new text", () => {
    applyLocalOps(t.db, [
      { op: "update_text", uid: "uid_r1", text: "now mentions [[ML]]" },
    ], 99);
    expect(blockRow("uid_r1").text).toBe("now mentions [[ML]]");
    expect(rows("SELECT target_page_id FROM refs WHERE src_block_uid='uid_r1'"))
      .toEqual([{ target_page_id: 2 }]);
    expect(rows(
      "SELECT b.uid FROM blocks b JOIN blocks_fts f ON f.rowid = b.rowid" +
      " WHERE blocks_fts MATCH 'mentions'")).toEqual([{ uid: "uid_r1" }]);
  });

  test("cross-page move rewrites the whole subtree's page_id", () => {
    applyLocalOps(t.db, [{
      op: "move", uid: "uid_r2", parent_uid: null, order_idx: 0,
      page_title: "ML",
    }], 99);
    expect(blockRow("uid_r2").page_id).toBe(2);
    expect(blockRow("uid_r2c").page_id).toBe(2); // descendant followed
  });

  test("move under a parent on the same page shifts siblings at the target", () => {
    applyLocalOps(t.db, [{
      op: "move", uid: "uid_r1", parent_uid: "uid_r2", order_idx: 0,
      page_title: null,
    }], 99);
    expect(blockRow("uid_r1").parent_uid).toBe("uid_r2");
    expect(blockRow("uid_r1").order_idx).toBe(0);
    expect(blockRow("uid_r2c").order_idx).toBe(1); // shifted under uid_r2
  });

  test("delete removes the subtree deepest-first (children gone too)", () => {
    applyLocalOps(t.db, [{ op: "delete", uid: "uid_r2" }], 99);
    expect(rows("SELECT uid FROM blocks")).toEqual([{ uid: "uid_r1" }]);
    expect(rows("SELECT COUNT(*) AS n FROM refs")).toEqual([{ n: 0 }]);
  });

  test("set_collapsed and set_heading update flags", () => {
    applyLocalOps(t.db, [
      { op: "set_collapsed", uid: "uid_r2", collapsed: true },
      { op: "set_heading", uid: "uid_r1", heading: 2 },
    ], 99);
    expect(blockRow("uid_r2").collapsed).toBe(1);
    expect(blockRow("uid_r1").heading).toBe(2);
  });

  test("create_page is a local get-or-create (idempotent, negative id)", () => {
    applyLocalOps(t.db, [
      { op: "create_page", page_title: "Fresh Offline Page" },
      { op: "create_page", page_title: "Fresh Offline Page" },
    ], 99);
    const pages = rows<{ id: number }>(
      "SELECT id FROM pages WHERE title = 'Fresh Offline Page'");
    expect(pages.length).toBe(1);
    expect(pages[0].id).toBeLessThan(0);
  });

  test("a batch applies atomically: a bad op rolls the whole batch back", () => {
    expect(() => applyLocalOps(t.db, [
      { op: "update_text", uid: "uid_r1", text: "changed" },
      { op: "delete", uid: "uid_missing" },
    ], 99)).toThrow(/block not found/);
    expect(blockRow("uid_r1").text).toBe("first"); // rolled back
  });

  test("touches the page's updated_at", () => {
    applyLocalOps(t.db, [
      { op: "update_text", uid: "uid_r1", text: "changed" },
    ], 12345);
    expect(rows("SELECT updated_at FROM pages WHERE id = 1"))
      .toEqual([{ updated_at: 12345 }]);
  });
});
