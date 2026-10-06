// @vitest-environment node
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BatchId, BlockUid, OrderIdx, PageId } from "../api/brands";
import { applySnapshot } from "./apply";
import { reindexBlockRefs } from "./blockRefs";
import type { ReplicaDb } from "./db";
import { enqueueBatch } from "./queue";
import { batchesArb, replicaStateArb, snapshotOf } from "./replayArbs";
import { recordBlocks, recordPage, recordSiblingsFrom } from "./replayLog";
import { rewind } from "./rewind";
import { openTestDb, type TestDb } from "./testDb";

let t: TestDb;
afterEach(() => { vi.restoreAllMocks(); });
const P = 1 as PageId;
const b1 = "b1" as BatchId;
const b2 = "b2" as BatchId;
const u = (s: string) => s as BlockUid;
const idx = (n: number) => n as OrderIdx;

beforeEach(async () => {
  t?.close();
  t = await openTestDb();
  t.db.exec("INSERT INTO pages(id, title, created_at, updated_at) VALUES" +
            " (1, 'P', 1, 10), (2, 'S', 2, 20), (3, 'T', 3, 30)");
  t.db.exec(
    "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading," +
    " collapsed, created_at, updated_at, view_type) VALUES" +
    " ('a', 1, NULL, 0, 'see [[S]] ((uid-c1x))', 2, 0, 50, 100, 'numbered')," +
    " ('b', 1, NULL, 1, 'b', NULL, 0, 50, 100, NULL)," +
    " ('c', 1, NULL, 2, 'c', NULL, 1, 50, 100, 'document')," +
    " ('c1', 1, 'c', 0, 'c1', NULL, 0, 50, 111, NULL)," +
    " ('c11', 1, 'c1', 0, 'c11', NULL, 0, 50, 111, NULL)," +
    " ('c2', 1, 'c', 1, 'c2 [[T]]', NULL, 0, 50, 111, NULL)");
  t.db.exec("INSERT INTO refs VALUES ('a', 2, 'link'), ('c2', 3, 'link')");
  t.db.exec("INSERT INTO block_refs VALUES ('a', 'uid-c1x')");
});

/** Production rewinds inside applyWindow's transaction, which defers FKs;
 * COMMIT then fails if the rewind left a dangling parent or page. */
const inTx = <T>(fn: () => T, db: ReplicaDb = t.db): T => db.transaction(() => {
  db.exec("PRAGMA defer_foreign_keys = ON");
  return fn();
});
const dump = (db: ReplicaDb = t.db) => ({
  blocks: db.select(
    "SELECT uid, page_id, parent_uid, order_idx, text, heading, collapsed," +
    " created_at, updated_at, view_type FROM blocks ORDER BY uid"),
  pages: db.select(
    "SELECT id, title, created_at, updated_at FROM pages ORDER BY id"),
  refs: db.select(
    "SELECT src_block_uid, target_page_id, kind FROM refs ORDER BY 1, 2, 3"),
  blockRefs: db.select(
    "SELECT src_block_uid, target_block_uid FROM block_refs ORDER BY 1, 2"),
});
const ftsIntact = (db: ReplicaDb = t.db) => {
  db.exec("INSERT INTO blocks_fts(blocks_fts, rank) VALUES('integrity-check', 1)");
  db.exec("INSERT INTO pages_fts(pages_fts, rank) VALUES('integrity-check', 1)");
};
const logSize = () =>
  t.db.select<{ n: number }>("SELECT COUNT(*) AS n FROM replay_log")[0].n;
const pageIds = () =>
  t.db.select<{ id: number }>("SELECT id FROM pages ORDER BY id").map((r) => r.id);
const pend = (...ids: string[]) => {
  for (const id of ids) {
    t.db.exec("INSERT INTO pending_ops(batch_id, ops_json) VALUES (?, '[]')", [id]);
  }
};

// The writes below stand in for localOps.ts: each records, then writes.
const mint = (batchId: BatchId, id: number, title: string) => {
  recordPage(t.db, batchId, id as PageId, true);
  t.db.exec("INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
            [id, title, 900, 900]);
};
const touch = (batchId: BatchId, pageId: PageId) => {
  recordPage(t.db, batchId, pageId, false);
  t.db.exec("UPDATE pages SET updated_at = 900 WHERE id = ?", [pageId]);
};
const setText = (batchId: BatchId, uid: string, text: string,
                 refs: [number, string][] = []) => {
  recordBlocks(t.db, batchId, [u(uid)]);
  t.db.exec("UPDATE blocks SET text = ?, updated_at = 900 WHERE uid = ?", [text, uid]);
  t.db.exec("DELETE FROM refs WHERE src_block_uid = ?", [uid]);
  for (const [pageId, kind] of refs) {
    t.db.exec("INSERT INTO refs VALUES (?,?,?)", [uid, pageId, kind]);
  }
  reindexBlockRefs(t.db, u(uid), text);
};
const create = (batchId: BatchId, uid: string, parentUid: string | null,
                orderIdx: number) => {
  recordSiblingsFrom(t.db, batchId,
    { pageId: P, parentUid: parentUid as BlockUid | null, fromOrderIdx: idx(orderIdx) });
  t.db.exec("UPDATE blocks SET order_idx = order_idx + 1" +
            " WHERE page_id = 1 AND parent_uid IS ? AND order_idx >= ?",
            [parentUid, orderIdx]);
  recordBlocks(t.db, batchId, [u(uid)]);
  t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text," +
            " created_at, updated_at) VALUES (?, 1, ?, ?, ?, 900, 900)",
            [uid, parentUid, orderIdx, uid]);
};
const move = (batchId: BatchId, uid: string, parentUid: string | null,
              orderIdx: number) => {
  recordSiblingsFrom(t.db, batchId,
    { pageId: P, parentUid: parentUid as BlockUid | null, fromOrderIdx: idx(orderIdx) });
  t.db.exec("UPDATE blocks SET order_idx = order_idx + 1" +
            " WHERE page_id = 1 AND parent_uid IS ? AND order_idx >= ?",
            [parentUid, orderIdx]);
  recordBlocks(t.db, batchId, [u(uid)]);
  t.db.exec("UPDATE blocks SET parent_uid = ?, order_idx = ?, updated_at = 900" +
            " WHERE uid = ?", [parentUid, orderIdx, uid]);
};
/** Records the subtree deepest first, as the delete loop walks it. */
const del = (batchId: BatchId, ...subtree: string[]) => {
  recordBlocks(t.db, batchId, subtree.map(u));
  t.db.exec("DELETE FROM blocks WHERE uid = ?", [subtree[subtree.length - 1]]);
};

describe("rewind", () => {
  test("with nothing in scope it changes nothing and frees no page", () => {
    const before = dump();
    expect(inTx(() => rewind(t.db, "all"))).toEqual(new Map());
    expect(dump()).toEqual(before);
    ftsIntact();
  });

  test("a present row returns to its pre-image, refs and block_refs included", () => {
    const before = dump();
    inTx(() => {
      mint(b1, -1, "N");
      touch(b1, P);
      setText(b1, "a", "now [[N]] ((uid-bbx))", [[-1, "link"]]);
      t.db.exec("UPDATE blocks SET heading = NULL, collapsed = 1," +
                " view_type = 'document' WHERE uid = 'a'");
      rewind(t.db, "all");
    });
    expect(dump()).toEqual(before);
    expect(logSize()).toBe(0);
    ftsIntact();
  });

  test("a deleted subtree comes back parents first, under its parent and page", () => {
    const before = dump();
    inTx(() => {
      touch(b1, P);
      del(b1, "c11", "c2", "c1", "c");
      rewind(t.db, "all");
    });
    expect(dump()).toEqual(before);
    ftsIntact();
  });

  test("a created row is deleted after a moved child is restored elsewhere", () => {
    const before = dump();
    inTx(() => {
      create(b1, "x", null, 1);
      move(b1, "c", "x", 0);
      rewind(t.db, "all");
    });
    expect(dump()).toEqual(before);
    ftsIntact();
  });

  test("restoring a parent row does not cascade its children", () => {
    const rowids = () => t.db.select(
      "SELECT uid, rowid FROM blocks WHERE uid IN ('c1', 'c11', 'c2') ORDER BY uid");
    const before = dump();
    const ids = rowids();
    inTx(() => {
      setText(b1, "c", "c edited");
      rewind(t.db, "all");
    });
    expect(dump()).toEqual(before);
    expect(rowids()).toEqual(ids);
    ftsIntact();
    expect(t.db.select("SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH 'c11'"))
      .toEqual([{ rowid: ids[1].rowid }]);
  });

  test("the oldest batch's pre-image wins across batches", () => {
    const before = dump();
    pend("b1", "b2");
    inTx(() => {
      setText(b1, "a", "one");
      setText(b2, "a", "two");
      rewind(t.db, "pending");
    });
    expect(dump()).toEqual(before);
    expect(logSize()).toBe(0);
    ftsIntact();
  });

  test("scope pending leaves a settled batch's records and rows", () => {
    pend("b2");
    const after = inTx(() => {
      setText(b1, "a", "one");
      const settled = dump();
      setText(b2, "b", "bee [[S]]", [[2, "link"]]);
      rewind(t.db, "pending");
      return settled;
    });
    expect(dump()).toEqual(after);
    expect(t.db.select("SELECT DISTINCT batch_id FROM replay_log"))
      .toEqual([{ batch_id: "b1" }]);
    ftsIntact();
  });

  test("a minted page is deleted and returned by title; a page a block still holds is kept", () => {
    const freed = inTx(() => {
      mint(b1, -1, "N");
      mint(b1, -2, "U");
      mint(b1, -3, "V");
      setText(b1, "a", "[[N]] [[V]]", [[-1, "link"], [-3, "link"]]);
      // rows the window shipped: not recorded, so not rewound
      t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
                " VALUES ('z', -2, NULL, 0, 'z')");
      t.db.exec("INSERT INTO refs VALUES ('b', -3, 'link')");
      return rewind(t.db, "all");
    });
    expect(freed).toEqual(new Map([["N", -1]]));
    expect(pageIds()).toEqual([-3, -2, 1, 2, 3]);
    ftsIntact();
  });

  test("a recorded ref to a page that no longer exists is not restored", () => {
    inTx(() => {
      setText(b1, "a", "plain");
      // a page tombstone the window applied
      t.db.exec("DELETE FROM pages WHERE id = 2");
      rewind(t.db, "all");
    });
    expect(t.db.select("SELECT text FROM blocks WHERE uid = 'a'"))
      .toEqual([{ text: "see [[S]] ((uid-c1x))" }]);
    expect(t.db.select("SELECT src_block_uid FROM refs ORDER BY 1"))
      .toEqual([{ src_block_uid: "c2" }]);
    expect(t.db.select("SELECT src_block_uid, target_block_uid FROM block_refs"))
      .toEqual([{ src_block_uid: "a", target_block_uid: "uid-c1x" }]);
    ftsIntact();
  });

  test("a row restored in place sits under a parent re-inserted in the same rewind", () => {
    const before = dump();
    inTx(() => {
      // c1 leaves c for the top level, then c's subtree is deleted: after the
      // rewind c1 (present, updated) must hang under c (absent, re-inserted)
      move(b1, "c1", null, 3);
      del(b1, "c2");
      del(b1, "c");
      expect(t.db.select("SELECT uid FROM blocks WHERE uid IN ('c', 'c2')")).toEqual([]);
      rewind(t.db, "all");
    });
    expect(t.db.select(
      "SELECT uid, page_id, parent_uid, order_idx FROM blocks" +
      " WHERE uid IN ('c', 'c1', 'c11', 'c2') ORDER BY uid")).toEqual([
      { uid: "c", page_id: 1, parent_uid: null, order_idx: 2 },
      { uid: "c1", page_id: 1, parent_uid: "c", order_idx: 0 },
      { uid: "c11", page_id: 1, parent_uid: "c1", order_idx: 0 },
      { uid: "c2", page_id: 1, parent_uid: "c", order_idx: 1 },
    ]);
    expect(dump()).toEqual(before);
    expect(logSize()).toBe(0);
    ftsIntact();
  });

  test("a rewound block whose parent is gone is dropped", () => {
    inTx(() => {
      move(b1, "c1", null, 3);
      // a block tombstone the window applied: c no longer holds c1
      t.db.exec("DELETE FROM blocks WHERE uid = 'c'");
      rewind(t.db, "all");
    });
    expect(t.db.select("SELECT uid FROM blocks ORDER BY uid"))
      .toEqual([{ uid: "a" }, { uid: "b" }]);
    expect(logSize()).toBe(0);
    ftsIntact();
  });

  test("a deleted row whose parent is gone is never placed", () => {
    inTx(() => {
      del(b1, "c11", "c1");
      t.db.exec("DELETE FROM blocks WHERE uid = 'c'");
      rewind(t.db, "all");
    });
    expect(t.db.select("SELECT uid FROM blocks ORDER BY uid"))
      .toEqual([{ uid: "a" }, { uid: "b" }]);
    expect(logSize()).toBe(0);
    ftsIntact();
  });

  test("a positive page id is never deleted, whatever its record says", () => {
    inTx(() => {
      recordPage(t.db, b1, 2 as PageId, true);
      t.db.exec("DELETE FROM refs WHERE target_page_id = 2");
      expect(rewind(t.db, "all")).toEqual(new Map());
    });
    expect(pageIds()).toEqual([1, 2, 3]);
    ftsIntact();
  });

  test("enqueue then rewind all restores the database exactly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await fc.assert(fc.asyncProperty(
      replicaStateArb.chain((state) => fc.tuple(fc.constant(state), batchesArb(state))),
      async ([state, batches]) => {
        const r = await openTestDb();
        try {
          applySnapshot(r.db, snapshotOf(state, 10), 5);
          const before = dump(r.db);
          for (const b of batches) enqueueBatch(r.db, b.ops, 500, b.batchId);
          inTx(() => rewind(r.db, "all"), r.db);
          expect(dump(r.db)).toEqual(before);
          expect(r.db.select("SELECT COUNT(*) AS n FROM replay_log")).toEqual([{ n: 0 }]);
          expect(r.db.select("SELECT COUNT(*) AS n FROM replay_log_refs"))
            .toEqual([{ n: 0 }]);
          ftsIntact(r.db);
        } finally {
          r.close();
        }
      }), { numRuns: 150 });
    // The generated batches collide on purpose (a create of an existing uid);
    // the engine logs each failed statement, and nothing else may be logged.
    for (const call of warn.mock.calls) {
      expect(call.slice(0, 3)).toEqual(
        ["sqlite3_step() rc=", expect.any(Number), "SQLITE_CONSTRAINT_PRIMARYKEY"]);
    }
  });
});
