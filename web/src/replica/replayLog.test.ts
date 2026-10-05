// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type { BatchId, BlockUid, OrderIdx, PageId } from "../api/brands";
import {
  type BlockPreImage, clearReplayLog, dropWindowRecords, enqueuedAt,
  pruneReplayBatches, recordBlocks, recordEnqueue, recordPage,
  recordSiblingsFrom, remapLogPage,
} from "./replayLog";
import { openTestDb, type TestDb } from "./testDb";

let t: TestDb;
const P = 1 as PageId;
const b1 = "b1" as BatchId;
const b2 = "b2" as BatchId;
const u = (s: string) => s as BlockUid;
const idx = (n: number) => n as OrderIdx;

beforeEach(async () => {
  t?.close();
  t = await openTestDb();
  t.db.exec("INSERT INTO pages(id, title, updated_at) VALUES" +
            " (1, 'P', 10), (2, 'S', 20), (3, 'T', 30)");
  t.db.exec(
    "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, updated_at) VALUES" +
    " ('a', 1, NULL, 0, 'see [[S]] #T', 100)," +
    " ('b', 1, NULL, 1, 'b', 100)," +
    " ('c', 1, NULL, 2, 'c', 100)," +
    " ('c1', 1, 'c', 0, 'c1', 111)," +
    " ('c2', 1, 'c', 1, 'c2', 111)");
  t.db.exec("INSERT INTO refs VALUES ('a', 2, 'link'), ('a', 3, 'tag')");
});

const pend = (...ids: string[]) => {
  for (const id of ids) {
    t.db.exec("INSERT INTO pending_ops(batch_id, ops_json) VALUES (?, '[]')", [id]);
  }
};
type LogRow = {
  batch_id: string; kind: string; key: string;
  pre: unknown; pre_page_id: number | null;
};
const log = (): LogRow[] => t.db.select<{
  batch_id: string; kind: string; key: string; pre_json: string | null;
  pre_page_id: number | null;
}>("SELECT batch_id, kind, key, pre_json, pre_page_id FROM replay_log" +
   " ORDER BY id").map(({ pre_json, ...r }) => ({
  ...r, pre: pre_json === null ? null : JSON.parse(pre_json) as unknown }));
const logRefs = () => t.db.select<{
  batch_id: string; key: string; target_page_id: number; kind: string;
}>("SELECT l.batch_id, l.key, r.target_page_id, r.kind" +
   " FROM replay_log_refs r JOIN replay_log l ON l.id = r.log_id" +
   " ORDER BY l.id, r.target_page_id, r.kind");
const keys = () => log().map((r) => [r.batch_id, r.kind, r.key]);

describe("recording", () => {
  test("the first touch per batch wins", () => {
    recordBlocks(t.db, b1, [u("a")]);
    t.db.exec("UPDATE blocks SET text = 'changed', updated_at = 200 WHERE uid = 'a'");
    recordBlocks(t.db, b1, [u("a")]);
    const pre: BlockPreImage = {
      parent_uid: null, order_idx: idx(0), text: "see [[S]] #T", heading: null,
      collapsed: 0, created_at: null, updated_at: 100, view_type: null };
    expect(log()).toEqual([
      { batch_id: "b1", kind: "block", key: "a", pre, pre_page_id: 1 }]);
  });

  test("an absent uid records a NULL pre-image", () => {
    recordBlocks(t.db, b1, [u("x")]);
    expect(log()).toEqual([
      { batch_id: "b1", kind: "block", key: "x", pre: null, pre_page_id: null }]);
    expect(logRefs()).toEqual([]);
  });

  test("refs rows are recorded with the block", () => {
    recordBlocks(t.db, b1, [u("a"), u("b")]);
    t.db.exec("DELETE FROM refs WHERE src_block_uid = 'a'");
    t.db.exec("INSERT INTO refs VALUES ('a', 1, 'link')");
    // a second touch by the same batch records nothing more
    recordBlocks(t.db, b1, [u("a")]);
    expect(logRefs()).toEqual([
      { batch_id: "b1", key: "a", target_page_id: 2, kind: "link" },
      { batch_id: "b1", key: "a", target_page_id: 3, kind: "tag" }]);
  });

  test("recordSiblingsFrom records exactly the rows at or after the slot in that group", () => {
    recordSiblingsFrom(t.db, b1, { pageId: P, parentUid: null, fromOrderIdx: idx(1) });
    recordSiblingsFrom(t.db, b2, { pageId: P, parentUid: u("c"), fromOrderIdx: idx(1) });
    expect(keys()).toEqual([
      ["b1", "block", "b"], ["b1", "block", "c"], ["b2", "block", "c2"]]);
    expect(log()[1].pre_page_id).toBe(1);
  });

  test("recordPage records updated_at, or NULL for a page the batch minted", () => {
    t.db.exec("INSERT INTO pages(id, title, updated_at) VALUES (-1, 'L', 5)");
    recordPage(t.db, b1, P, false);
    recordPage(t.db, b1, -1 as PageId, true);
    t.db.exec("UPDATE pages SET updated_at = 99 WHERE id = 1");
    recordPage(t.db, b1, P, false);
    expect(log()).toEqual([
      { batch_id: "b1", kind: "page", key: "1", pre: { updated_at: 10 },
        pre_page_id: null },
      { batch_id: "b1", kind: "page", key: "-1", pre: null, pre_page_id: null }]);
  });
});

describe("drops", () => {
  test("dropWindowRecords leaves a pending batch's records and drops a settled batch's", () => {
    recordBlocks(t.db, b1, [u("a"), u("b")]);
    recordBlocks(t.db, b2, [u("a")]);
    pend("b2");
    dropWindowRecords(t.db, { uids: [u("a")], pageIds: [] });
    expect(keys()).toEqual([["b1", "block", "b"], ["b2", "block", "a"]]);
    // the dropped record's refs went with it
    expect(logRefs().map((r) => r.batch_id)).toEqual(["b2", "b2"]);
  });

  test("dropWindowRecords drops a settled page record for a shipped page id", () => {
    t.db.exec("INSERT INTO pages(id, title) VALUES (-4, 'L')");
    recordPage(t.db, b1, P, false);
    recordPage(t.db, b1, -4 as PageId, true);
    recordPage(t.db, b1, 2 as PageId, false);
    // a block keyed like a page id is not a page record
    recordBlocks(t.db, b1, [u("1")]);
    dropWindowRecords(t.db, { uids: [], pageIds: [P, -4 as PageId] });
    expect(keys()).toEqual([["b1", "page", "2"], ["b1", "block", "1"]]);
  });

  test("clearReplayLog empties the log and its refs", () => {
    recordBlocks(t.db, b1, [u("a")]);
    recordPage(t.db, b1, P, false);
    clearReplayLog(t.db);
    expect(log()).toEqual([]);
    expect(t.db.select("SELECT 1 FROM replay_log_refs")).toEqual([]);
  });

  test("pruneReplayBatches keeps only batches still queued", () => {
    recordEnqueue(t.db, b1, 1000);
    recordEnqueue(t.db, b2, 2000);
    recordEnqueue(t.db, b2, 3000);
    pend("b2");
    pruneReplayBatches(t.db);
    expect(enqueuedAt(t.db, b1)).toBeNull();
    expect(enqueuedAt(t.db, b2)).toBe(2000);
  });
});

describe("remapLogPage", () => {
  test("remapLogPage re-keys pre_page_id, refs targets and a present page record, and deletes a minted one", () => {
    t.db.exec("INSERT INTO pages(id, title, updated_at) VALUES (-1, 'L', 40)");
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('x', -1, NULL, 0, '[[L]]')");
    t.db.exec("INSERT INTO refs VALUES ('x', -1, 'link')");
    recordBlocks(t.db, b1, [u("x")]);
    recordPage(t.db, b1, -1 as PageId, false);
    recordPage(t.db, b2, -1 as PageId, true);
    remapLogPage(t.db, { localId: -1 as PageId, targetId: 9 as PageId });
    expect(log()).toEqual([
      { batch_id: "b1", kind: "block", key: "x", pre: expect.anything() as unknown,
        pre_page_id: 9 },
      { batch_id: "b1", kind: "page", key: "9", pre: { updated_at: 40 },
        pre_page_id: null }]);
    expect(logRefs()).toEqual([
      { batch_id: "b1", key: "x", target_page_id: 9, kind: "link" }]);
  });

  test("the target's own page record wins over the re-keyed one", () => {
    t.db.exec("INSERT INTO pages(id, title, updated_at) VALUES (-1, 'L', 40)");
    recordPage(t.db, b1, P, false);
    recordPage(t.db, b1, -1 as PageId, false);
    remapLogPage(t.db, { localId: -1 as PageId, targetId: P });
    expect(log()).toEqual([
      { batch_id: "b1", kind: "page", key: "1", pre: { updated_at: 10 },
        pre_page_id: null }]);
  });
});
