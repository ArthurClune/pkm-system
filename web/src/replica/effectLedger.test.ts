// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type { BatchId, BlockUid, OrderIdx, PageId } from "../api/brands";
import {
  clearLedger, dropRecordsOf, dropWindowRecords, recordCascade, recordRepage,
  recordShift, remapBasePage, settleBatches,
} from "./effectLedger";
import { openTestDb, type TestDb } from "./testDb";

let t: TestDb;
const P = 1 as PageId;
const S = 2 as PageId;
const b1 = "b1" as BatchId;
const b2 = "b2" as BatchId;
const u = (s: string) => s as BlockUid;
const idx = (n: number) => n as OrderIdx;

beforeEach(async () => {
  t?.close();
  t = await openTestDb();
  t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'P'), (2, 'S')");
  t.db.exec(
    "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, updated_at) VALUES" +
    " ('a', 1, NULL, 0, 'a', 100)," +
    " ('b', 1, NULL, 1, 'b', 100)," +
    " ('c', 1, NULL, 2, 'c', 100)," +
    " ('c1', 1, 'c', 0, 'c1', 111)");
});

const pend = (...ids: string[]) => {
  for (const id of ids) {
    t.db.exec("INSERT INTO pending_ops(batch_id, ops_json) VALUES (?, '[]')", [id]);
  }
};
const ledger = () => t.db.select<{
  batch_id: string; uid: string; order_delta: number;
  base_page_id: number | null; base_updated_at: number | null;
}>("SELECT batch_id, uid, order_delta, base_page_id, base_updated_at" +
  " FROM effect_ledger ORDER BY batch_id, uid");
const blk = (uid: string) => t.db.select<{
  page_id: number; order_idx: number; updated_at: number | null;
}>("SELECT page_id, order_idx, updated_at FROM blocks WHERE uid = ?", [uid])[0];
const rowRec = (uid: string) => t.db.select<{
  batch_id: string; base_page_id: number | null; base_updated_at: number | null;
  order_delta: number; row_json: string | null;
}>("SELECT batch_id, base_page_id, base_updated_at, order_delta, row_json" +
   " FROM effect_ledger WHERE uid = ?", [uid]);
const topGroup = { pageId: P, parentUid: null, fromOrderIdx: idx(1) };

describe("recordShift", () => {
  test("records +1 per row at or past the slot, never the excepted uid", () => {
    recordShift(t.db, b1, topGroup, u("a"));
    expect(ledger().map((r) => [r.uid, r.order_delta])).toEqual(
      [["b", 1], ["c", 1]]);
    clearLedger(t.db);
    recordShift(t.db, b1, { ...topGroup, fromOrderIdx: idx(0) }, u("a"));
    expect(ledger().map((r) => r.uid)).toEqual(["b", "c"]);
  });

  test("a second shift by the same batch adds to the delta", () => {
    recordShift(t.db, b1, topGroup, u("a"));
    recordShift(t.db, b1, topGroup, u("a"));
    expect(ledger().find((r) => r.uid === "b")?.order_delta).toBe(2);
  });

  test("two batches keep separate deltas", () => {
    recordShift(t.db, b1, topGroup, u("a"));
    recordShift(t.db, b2, topGroup, u("a"));
    expect(ledger().map((r) => [r.batch_id, r.uid, r.order_delta])).toEqual([
      ["b1", "b", 1], ["b1", "c", 1], ["b2", "b", 1], ["b2", "c", 1]]);
  });
});

describe("recordRepage", () => {
  test("takes the row's page and updated_at as base when no record has one", () => {
    recordRepage(t.db, b1, u("c1"));
    expect(ledger()).toEqual([{
      batch_id: "b1", uid: "c1", order_delta: 0,
      base_page_id: 1, base_updated_at: 111 }]);
  });

  test("copies another batch's base", () => {
    recordRepage(t.db, b1, u("c1"));
    t.db.exec("UPDATE blocks SET page_id = 2, updated_at = 222 WHERE uid = 'c1'");
    recordRepage(t.db, b2, u("c1"));
    expect(ledger().map((r) => [r.batch_id, r.base_page_id, r.base_updated_at]))
      .toEqual([["b1", 1, 111], ["b2", 1, 111]]);
  });

  test("a batch's page record keeps its first base", () => {
    recordRepage(t.db, b1, u("c1"));
    t.db.exec("UPDATE blocks SET page_id = 2, updated_at = 222 WHERE uid = 'c1'");
    recordRepage(t.db, b1, u("c1"));
    expect(ledger()).toEqual([{
      batch_id: "b1", uid: "c1", order_delta: 0,
      base_page_id: 1, base_updated_at: 111 }]);
  });

  test("on an order-only record adds the base and keeps the delta", () => {
    recordShift(t.db, b1, { pageId: P, parentUid: u("c"), fromOrderIdx: idx(0) },
      u("zz"));
    recordRepage(t.db, b1, u("c1"));
    expect(ledger()).toEqual([{
      batch_id: "b1", uid: "c1", order_delta: 1,
      base_page_id: 1, base_updated_at: 111 }]);
  });

  test("is a no-op for a missing row", () => {
    recordRepage(t.db, b1, u("nope"));
    expect(ledger()).toEqual([]);
  });
});

describe("drops", () => {
  test("dropRecordsOf deletes every batch's records on the uid, and only those", () => {
    recordRepage(t.db, b1, u("c1"));
    recordRepage(t.db, b2, u("c1"));
    recordRepage(t.db, b1, u("a"));
    dropRecordsOf(t.db, u("c1"));
    expect(ledger().map((r) => [r.batch_id, r.uid])).toEqual([["b1", "a"]]);
  });

  test("dropWindowRecords deletes records on the listed uids; empty list and empty ledger change nothing", () => {
    dropWindowRecords(t.db, [u("a")]); // empty ledger
    expect(ledger()).toEqual([]);
    recordRepage(t.db, b1, u("c1"));
    recordRepage(t.db, b1, u("a"));
    dropWindowRecords(t.db, []);
    expect(ledger()).toHaveLength(2);
    dropWindowRecords(t.db, [u("c1"), u("zz")]);
    expect(ledger().map((r) => r.uid)).toEqual(["a"]);
  });
});

describe("settleBatches", () => {
  test("leaves records whose batch is pending, including a poisoned one", () => {
    pend(b1, b2);
    t.db.exec("UPDATE pending_ops SET poisoned = 1 WHERE batch_id = 'b2'");
    recordShift(t.db, b1, topGroup, u("a"));
    recordRepage(t.db, b2, u("c1"));
    const before = ledger();
    settleBatches(t.db);
    expect(ledger()).toEqual(before);
    expect(blk("b").order_idx).toBe(1);
  });

  test("subtracts the summed delta of every settling batch", () => {
    pend(b2);
    recordShift(t.db, b1, topGroup, u("a"));
    recordShift(t.db, b2, topGroup, u("a"));
    t.db.exec("UPDATE blocks SET order_idx = order_idx + 2 WHERE uid IN ('b','c')");
    settleBatches(t.db);
    expect(blk("b").order_idx).toBe(2);
    expect(blk("c").order_idx).toBe(3);
    expect(ledger().map((r) => [r.batch_id, r.uid])).toEqual(
      [["b2", "b"], ["b2", "c"]]);
  });

  test("every settling batch's delta on one uid is subtracted together", () => {
    recordShift(t.db, b1, topGroup, u("a"));
    recordShift(t.db, b2, topGroup, u("a"));
    t.db.exec("UPDATE blocks SET order_idx = order_idx + 2 WHERE uid IN ('b','c')");
    settleBatches(t.db);
    expect(blk("b").order_idx).toBe(1);
    expect(blk("c").order_idx).toBe(2);
    expect(ledger()).toEqual([]);
  });

  test("a NULL base updated_at is written back as NULL", () => {
    t.db.exec("UPDATE blocks SET updated_at = NULL WHERE uid = 'c1'");
    recordRepage(t.db, b1, u("c1"));
    t.db.exec("UPDATE blocks SET page_id = 2, updated_at = 222 WHERE uid = 'c1'");
    settleBatches(t.db);
    expect(blk("c1")).toEqual({ page_id: 1, order_idx: 0, updated_at: null });
  });

  test("writes the base page and updated_at only when the last page record goes", () => {
    recordRepage(t.db, b1, u("c1"));
    recordRepage(t.db, b2, u("c1"));
    t.db.exec("UPDATE blocks SET page_id = 2, updated_at = 222 WHERE uid = 'c1'");
    pend(b2);
    settleBatches(t.db);
    expect(blk("c1")).toEqual({ page_id: 2, order_idx: 0, updated_at: 222 });
    t.db.exec("DELETE FROM pending_ops");
    settleBatches(t.db);
    expect(blk("c1")).toEqual({ page_id: 1, order_idx: 0, updated_at: 111 });
    expect(ledger()).toEqual([]);
  });

  test("leaves a row whose base page is gone", () => {
    t.db.exec("INSERT INTO pages(id, title) VALUES (3, 'G')");
    t.db.exec("UPDATE blocks SET page_id = 3 WHERE uid = 'c1'");
    recordRepage(t.db, b1, u("c1"));
    t.db.exec("UPDATE blocks SET page_id = 2 WHERE uid = 'c1'");
    t.db.exec("DELETE FROM pages WHERE id = 3");
    settleBatches(t.db);
    expect(blk("c1").page_id).toBe(2);
    expect(ledger()).toEqual([]);
  });

  test("changes nothing for a missing uid and deletes its records", () => {
    t.db.exec(
      "INSERT INTO effect_ledger(batch_id, uid, order_delta, base_page_id) VALUES ('b1','ghost',1,1)");
    const before = t.db.select("SELECT * FROM blocks ORDER BY uid");
    settleBatches(t.db);
    expect(t.db.select("SELECT * FROM blocks ORDER BY uid")).toEqual(before);
    expect(ledger()).toEqual([]);
  });
});

describe("recordCascade", () => {
  test("stores the base row with pending shifts taken out and absorbs every other record", () => {
    recordShift(t.db, b1, { pageId: P, parentUid: u("c"), fromOrderIdx: idx(0) }, u("x"));
    t.db.exec("UPDATE blocks SET order_idx = 1 WHERE uid = 'c1'");
    recordCascade(t.db, b2, u("c1"));
    const recs = rowRec("c1");
    expect(recs.map(({ row_json, ...r }) => r)).toEqual([
      { batch_id: "b2", base_page_id: 1, base_updated_at: null, order_delta: 0 }]);
    expect(JSON.parse(recs[0].row_json!)).toEqual({
      parent_uid: "c", order_idx: 0, text: "c1", heading: null, collapsed: 0,
      created_at: null, updated_at: 111, view_type: null });
  });

  test("takes the page and updated_at an earlier page record carries", () => {
    recordRepage(t.db, b1, u("c1"));
    t.db.exec("UPDATE blocks SET page_id = 2, updated_at = 222 WHERE uid = 'c1'");
    recordCascade(t.db, b2, u("c1"));
    const [rec] = rowRec("c1");
    expect(rec.base_page_id).toBe(1);
    expect(JSON.parse(rec.row_json!).updated_at).toBe(111);
  });
});

test("remapBasePage rewrites base_page_id from the local id to the target", () => {
  recordRepage(t.db, b1, u("c1"));
  recordRepage(t.db, b1, u("a"));
  t.db.exec("UPDATE effect_ledger SET base_page_id = -5 WHERE uid = 'c1'");
  remapBasePage(t.db, { localId: -5 as PageId, targetId: S });
  expect(ledger().map((r) => [r.uid, r.base_page_id])).toEqual(
    [["a", 1], ["c1", 2]]);
});

test("clearLedger empties the table", () => {
  recordRepage(t.db, b1, u("c1"));
  clearLedger(t.db);
  expect(ledger()).toEqual([]);
});
