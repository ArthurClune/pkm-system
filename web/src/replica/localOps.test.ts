// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import { applyLocalOps, getOrCreateLocalPage, LocalOpError, subtreeUids } from "./localOps";
import { setPlainSpaceTitleCanonicalization } from "./meta";
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
         text: string; collapsed: number; heading: number | null;
         view_type: "numbered" | "document" | null }>(
    `SELECT page_id, parent_uid, order_idx, text, collapsed, heading, view_type
     FROM blocks WHERE uid = '${uid}'`)[0];

const replicaState = () => ({
  pages: rows("SELECT * FROM pages ORDER BY id"),
  blocks: rows("SELECT * FROM blocks ORDER BY uid"),
  refs: rows("SELECT * FROM refs ORDER BY src_block_uid, target_page_id, kind"),
  sidebar: rows("SELECT * FROM sidebar_entries ORDER BY id"),
  metadata: rows("SELECT * FROM sync_client_meta ORDER BY key"),
});

const makeChain = (count: number, prefix: string) => {
  const uids = Array.from({ length: count }, (_, i) => `${prefix}_${i}`);
  t.db.exec(
    "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text) VALUES (?, 1, NULL, 0, ?)",
    [uids[0], `${prefix}_0`]);
  for (let i = 1; i < uids.length; i++) {
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text) VALUES (?, 1, ?, 0, ?)",
      [uids[i], uids[i - 1], `${prefix}_${i}`]);
  }
  return uids;
};

const makeCycle = () => {
  const [root, child] = makeChain(2, "cycle");
  t.db.exec("UPDATE blocks SET parent_uid = ? WHERE uid = ?", [child, root]);
  return [root, child] as const;
};

describe("subtreeUids", () => {
  test.each([
    [100, "depth_100"],
    [101, "depth_101"],
    [102, "depth_102"],
    [150, "depth_150"],
  ] as const)("returns all %i nodes deepest-first", (count, prefix) => {
    const uids = makeChain(count, prefix);

    expect(subtreeUids(t.db, uids[0])).toEqual([...uids].reverse());
  });

  test("returns each uid once across a corrupt cycle", () => {
    const [root, child] = makeCycle();

    expect(subtreeUids(t.db, root)).toEqual([child, root]);
  });
});

describe("getOrCreateLocalPage", () => {
  test("preserves boundary U+0020 while inactive and always normalizes control whitespace", () => {
    const padded = getOrCreateLocalPage(t.db, "  Offline Padded  ", 5);
    const control = getOrCreateLocalPage(t.db, "Control\nTitle", 5);

    expect(rows("SELECT title FROM pages WHERE id = " + padded))
      .toEqual([{ title: "  Offline Padded  " }]);
    expect(rows("SELECT title FROM pages WHERE id = " + control))
      .toEqual([{ title: "Control Title" }]);
  });

  test("canonicalizes creation and lookup while active", () => {
    setPlainSpaceTitleCanonicalization(t.db, true);

    const created = getOrCreateLocalPage(t.db, "  Active Page  ", 5);
    expect(getOrCreateLocalPage(t.db, "Active Page", 9)).toBe(created);
    expect(rows("SELECT id, title FROM pages WHERE title LIKE '%Active%'"))
      .toEqual([{ id: created, title: "Active Page" }]);
  });

  test("returns existing pages and mints distinct negative ids for new ones", () => {
    expect(getOrCreateLocalPage(t.db, "AI", 5)).toBe(1);
    const p1 = getOrCreateLocalPage(t.db, "Offline One", 5);
    const p2 = getOrCreateLocalPage(t.db, "Offline Two", 5);
    expect(p1).toBeLessThan(0);
    expect(p2).toBeLessThan(0);
    expect(p1).not.toBe(p2);
    expect(getOrCreateLocalPage(t.db, "Offline One", 9)).toBe(p1);
  });

  test("defensively rejects forbidden titles before creating a page", () => {
    const before = replicaState();

    expect(() => getOrCreateLocalPage(t.db, "Control\n#Title", 5))
      .toThrow(LocalOpError);
    expect(replicaState()).toEqual(before);
  });
});

describe("applyLocalOps", () => {
  test.each([
    ["create_page target", { op: "create_page", page_title: "Bad #Page" }],
    ["create target", { op: "create", uid: "uid_bad1",
      page_title: "Bad [[Page", parent_uid: null, order_idx: 0, text: "plain" }],
    ["move target", { op: "move", uid: "uid_r1", page_title: "Bad Page]]",
      parent_uid: null, order_idx: 0 }],
    ["create reference", { op: "create", uid: "uid_bad2", page_title: "AI",
      parent_uid: null, order_idx: 0, text: "[[Bad #Ref]]" }],
    ["update reference", { op: "update_text", uid: "uid_r1",
      text: "[[Bad #Ref]]" }],
  ] as const)("rejects a forbidden %s before mutation", (_name, op) => {
    const before = replicaState();

    expect(() => applyLocalOps(t.db, [op as BlockOp], 99))
      .toThrow(LocalOpError);
    expect(replicaState()).toEqual(before);
  });

  test.each([
    ["explicit page title", { op: "create_page", page_title: "Atomic #Bad" },
      "page_title", "Atomic #Bad"],
    ["extracted reference", { op: "update_text", uid: "uid_r2",
      text: "[[Atomic #Bad Ref]]" }, "reference", "Atomic #Bad Ref"],
  ] as const)("preflights a full batch before a later forbidden %s",
    (_name, invalidOp, source, title) => {
      t.db.exec("INSERT INTO sidebar_entries(id, title, order_idx) VALUES (1, 'AI', 0)");
      const before = replicaState();

      let thrown: unknown;
      try {
        applyLocalOps(t.db, [
          { op: "update_text", uid: "uid_r1", text: "would partially apply" },
          invalidOp as BlockOp,
        ], 99);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LocalOpError);
      expect(thrown).toMatchObject({ opIndex: 1, source, title });
      expect(replicaState()).toEqual(before);
    });

  test("create shifts following siblings and reindexes refs", () => {
    applyLocalOps(t.db, [{
      op: "create", uid: "uid_new1", page_title: "AI", parent_uid: null,
      order_idx: 1, text: "links [[ML]] and [[Brand New]]", view_type: "numbered",
    }], 99);
    expect(blockRow("uid_new1").order_idx).toBe(1);
    expect(blockRow("uid_new1").view_type).toBe("numbered");
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

  test("cross-page move rewrites every page_id in a 150-block subtree", () => {
    const uids = makeChain(150, "move_150");

    applyLocalOps(t.db, [{
      op: "move", uid: uids[0], parent_uid: null, order_idx: 0,
      page_title: "ML",
    }], 99);

    expect(rows<{ page_id: number }>(
      "SELECT page_id FROM blocks WHERE uid LIKE 'move_150_%' ORDER BY uid"
    ).map((row) => row.page_id)).toEqual(Array(150).fill(2));
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

  test("delete removes every row from a 150-block subtree", () => {
    const uids = makeChain(150, "delete_150");

    applyLocalOps(t.db, [{ op: "delete", uid: uids[0] }], 99);

    expect(rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM blocks WHERE uid LIKE 'delete_150_%'"
    )).toEqual([{ n: 0 }]);
  });

  test("set_collapsed and set_heading update flags", () => {
    applyLocalOps(t.db, [
      { op: "set_collapsed", uid: "uid_r2", collapsed: true },
      { op: "set_heading", uid: "uid_r1", heading: 2 },
    ], 99);
    expect(blockRow("uid_r2").collapsed).toBe(1);
    expect(blockRow("uid_r1").heading).toBe(2);
  });

  test("set_view_type updates persistent metadata", () => {
    applyLocalOps(t.db, [
      { op: "set_view_type", uid: "uid_r1", view_type: "numbered" },
    ], 99);
    expect(blockRow("uid_r1").view_type).toBe("numbered");
    expect(blockRow("uid_r1").text).toBe("first");
    expect(blockRow("uid_r1").parent_uid).toBeNull();
  });

  test("blank op titles use the server fallback instead of minting blank pages", () => {
    applyLocalOps(t.db, [
      { op: "create_page", page_title: "   " },
      { op: "create", uid: "uid_blank", page_title: "\n\t",
        parent_uid: null, order_idx: 0, text: "fallback" },
    ], 99);

    expect(rows("SELECT title FROM pages WHERE trim(title) = ''")).toEqual([]);
    const untitled = rows<{ id: number }>(
      "SELECT id FROM pages WHERE title = 'Untitled'");
    expect(untitled).toHaveLength(1);
    expect(blockRow("uid_blank").page_id).toBe(untitled[0].id);
  });

  test("active create, create_page and cross-page move share canonical page ids", () => {
    setPlainSpaceTitleCanonicalization(t.db, true);
    applyLocalOps(t.db, [
      { op: "create_page", page_title: "  Shared Target  " },
      { op: "create", uid: "uid_active", page_title: " Shared Target ",
        parent_uid: null, order_idx: 0, text: "active" },
      { op: "move", uid: "uid_r2", parent_uid: null, order_idx: 1,
        page_title: "  Shared Target " },
    ], 99);

    const target = rows<{ id: number }>(
      "SELECT id FROM pages WHERE title = 'Shared Target'");
    expect(target).toHaveLength(1);
    expect(blockRow("uid_active").page_id).toBe(target[0].id);
    expect(blockRow("uid_r2").page_id).toBe(target[0].id);
    expect(blockRow("uid_r2c").page_id).toBe(target[0].id);
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
