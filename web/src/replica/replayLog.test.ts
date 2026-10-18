// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type { BatchId, BlockUid, PageId } from "../api/brands";
import {
  type BlockPreImage, clearReplayLog, dropWindowRecords, enqueuedAt,
  pruneReplayBatches, recordBlocks, recordEnqueue, recordPage,
  recordSiblingsFrom, remapLogPage,
} from "./replayLog";
import { openTestDb, type TestDb } from "./testDb";
import { batchIdOf, malformedUid, orderIdxOf, pageIdOf, uidOf } from "../test-helpers";

let t: TestDb;
const P = pageIdOf(1);
const b1 = batchIdOf("b1");
const b2 = batchIdOf("b2");
const u = (s: string): BlockUid => uidOf(s);
const idx = (n: number) => orderIdxOf(n);

beforeEach(async () => {
  t?.close();
  t = await openTestDb();
  t.db.exec("INSERT INTO pages(id, title, updated_at) VALUES" +
            " (1, 'P', 10), (2, 'S', 20), (3, 'T', 30)");
  t.db.exec(
    "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, updated_at) VALUES" +
    " ('tuid-a', 1, NULL, 0, 'see [[S]] #T', 100)," +
    " ('tuid-b', 1, NULL, 1, 'b', 100)," +
    " ('tuid-c', 1, NULL, 2, 'c', 100)," +
    " ('tuid-c1', 1, 'tuid-c', 0, 'c1', 111)," +
    " ('tuid-c2', 1, 'tuid-c', 1, 'c2', 111)");
  t.db.exec("INSERT INTO refs VALUES ('tuid-a', 2, 'link'), ('tuid-a', 3, 'tag')");
});

const pend = (...ids: string[]) => {
  for (const id of ids) {
    t.db.exec("INSERT INTO pending_ops(batch_id, ops_json) VALUES (?, '[]')", [id]);
  }
};
type LogRow = {
  batch_id: BatchId; kind: string; key: string;
  pre: unknown; pre_page_id: PageId | null;
};
const log = (): LogRow[] => t.db.select<"batch_id" | "replay_kind" | "replay_key" | "pre_json" | "pre_page_id">(
  "SELECT batch_id, kind AS replay_kind, key AS replay_key, pre_json, pre_page_id FROM replay_log" +
  " ORDER BY id").map((r) => ({
  batch_id: r.batch_id, kind: r.replay_kind, key: r.replay_key,
  pre: r.pre_json === null ? null : JSON.parse(r.pre_json) as unknown,
  pre_page_id: r.pre_page_id }));
const logRefs = () => t.db.select<"batch_id" | "replay_key" | "target_page_id" | "ref_kind">(
  "SELECT l.batch_id, l.key AS replay_key, r.target_page_id, r.kind AS ref_kind" +
  " FROM replay_log_refs r JOIN replay_log l ON l.id = r.log_id" +
  " ORDER BY l.id, r.target_page_id, r.kind").map((r) => ({
  batch_id: r.batch_id, key: r.replay_key, target_page_id: r.target_page_id, kind: r.ref_kind }));
const keys = () => log().map((r) => [r.batch_id, r.kind, r.key]);

describe("recording", () => {
  test("the first touch per batch wins", () => {
    recordBlocks(t.db, b1, [u("tuid-a")]);
    t.db.exec("UPDATE blocks SET text = 'changed', updated_at = 200 WHERE uid = 'tuid-a'");
    recordBlocks(t.db, b1, [u("tuid-a")]);
    const pre: BlockPreImage = {
      parent_uid: null, order_idx: idx(0), text: "see [[S]] #T", heading: null,
      collapsed: 0, created_at: null, updated_at: 100, view_type: null };
    expect(log()).toEqual([
      { batch_id: b1, kind: "block", key: "tuid-a", pre, pre_page_id: 1 }]);
  });

  test("an absent uid records a NULL pre-image", () => {
    recordBlocks(t.db, b1, [u("tuid-x")]);
    expect(log()).toEqual([
      { batch_id: b1, kind: "block", key: "tuid-x", pre: null, pre_page_id: null }]);
    expect(logRefs()).toEqual([]);
  });

  test("refs rows are recorded with the block", () => {
    recordBlocks(t.db, b1, [u("tuid-a"), u("tuid-b")]);
    t.db.exec("DELETE FROM refs WHERE src_block_uid = 'tuid-a'");
    t.db.exec("INSERT INTO refs VALUES ('tuid-a', 1, 'link')");
    // a second touch by the same batch records nothing more
    recordBlocks(t.db, b1, [u("tuid-a")]);
    expect(logRefs()).toEqual([
      { batch_id: b1, key: "tuid-a", target_page_id: 2, kind: "link" },
      { batch_id: b1, key: "tuid-a", target_page_id: 3, kind: "tag" }]);
  });

  test("recordSiblingsFrom records exactly the rows at or after the slot in that group", () => {
    recordSiblingsFrom(t.db, b1, { pageId: P, parentUid: null, fromOrderIdx: idx(1) });
    recordSiblingsFrom(t.db, b2, { pageId: P, parentUid: u("tuid-c"), fromOrderIdx: idx(1) });
    expect(keys()).toEqual([
      ["b1", "block", "tuid-b"], ["b1", "block", "tuid-c"], ["b2", "block", "tuid-c2"]]);
    expect(log()[1].pre_page_id).toBe(1);
  });

  test("recordPage records updated_at, or NULL for a page the batch minted", () => {
    t.db.exec("INSERT INTO pages(id, title, updated_at) VALUES (-1, 'L', 5)");
    recordPage(t.db, b1, P, false);
    recordPage(t.db, b1, pageIdOf(-1), true);
    t.db.exec("UPDATE pages SET updated_at = 99 WHERE id = 1");
    recordPage(t.db, b1, P, false);
    expect(log()).toEqual([
      { batch_id: b1, kind: "page", key: "1", pre: { updated_at: 10 },
        pre_page_id: null },
      { batch_id: b1, kind: "page", key: "-1", pre: null, pre_page_id: null }]);
  });
});

describe("drops", () => {
  test("dropWindowRecords leaves a pending batch's records and drops a settled batch's", () => {
    recordBlocks(t.db, b1, [u("tuid-a"), u("tuid-b")]);
    recordBlocks(t.db, b2, [u("tuid-a")]);
    pend("b2");
    dropWindowRecords(t.db, { uids: [u("tuid-a")], pageIds: [] });
    expect(keys()).toEqual([["b1", "block", "tuid-b"], ["b2", "block", "tuid-a"]]);
    // the dropped record's refs went with it
    expect(logRefs().map((r) => r.batch_id)).toEqual(["b2", "b2"]);
  });

  test("dropWindowRecords drops a settled page record for a shipped page id", () => {
    t.db.exec("INSERT INTO pages(id, title) VALUES (-4, 'L')");
    recordPage(t.db, b1, P, false);
    recordPage(t.db, b1, pageIdOf(-4), true);
    recordPage(t.db, b1, pageIdOf(2), false);
    // a block keyed like a page id is not a page record; such a uid is
    // outside the BlockUid shape, so it is forged on purpose
    recordBlocks(t.db, b1, [malformedUid("1")]);
    dropWindowRecords(t.db, { uids: [], pageIds: [P, pageIdOf(-4)] });
    expect(keys()).toEqual([["b1", "page", "2"], ["b1", "block", "1"]]);
  });

  test("clearReplayLog empties the log and its refs", () => {
    recordBlocks(t.db, b1, [u("tuid-a")]);
    recordPage(t.db, b1, P, false);
    clearReplayLog(t.db);
    expect(log()).toEqual([]);
    expect(t.db.select("SELECT 1 AS n FROM replay_log_refs")).toEqual([]);
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
              " VALUES ('tuid-x', -1, NULL, 0, '[[L]]')");
    t.db.exec("INSERT INTO refs VALUES ('tuid-x', -1, 'link')");
    recordBlocks(t.db, b1, [u("tuid-x")]);
    recordPage(t.db, b1, pageIdOf(-1), false);
    recordPage(t.db, b2, pageIdOf(-1), true);
    remapLogPage(t.db, { localId: pageIdOf(-1), targetId: pageIdOf(9) });
    expect(log()).toEqual([
      { batch_id: b1, kind: "block", key: "tuid-x", pre: expect.anything() as unknown,
        pre_page_id: 9 },
      { batch_id: b1, kind: "page", key: "9", pre: { updated_at: 40 },
        pre_page_id: null }]);
    expect(logRefs()).toEqual([
      { batch_id: b1, key: "tuid-x", target_page_id: 9, kind: "link" }]);
  });

  test("the target's own page record wins over the re-keyed one", () => {
    t.db.exec("INSERT INTO pages(id, title, updated_at) VALUES (-1, 'L', 40)");
    recordPage(t.db, b1, P, false);
    recordPage(t.db, b1, pageIdOf(-1), false);
    remapLogPage(t.db, { localId: pageIdOf(-1), targetId: P });
    expect(log()).toEqual([
      { batch_id: b1, kind: "page", key: "1", pre: { updated_at: 10 },
        pre_page_id: null }]);
  });
});
