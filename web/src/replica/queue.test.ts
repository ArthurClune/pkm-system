// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type { UpdateTextOp } from "../api/ops";
import { allBatches, deleteBatch, enqueueBatch, markPoisoned, nextBatch,
         pendingCount } from "./queue";
import { sha256Hex } from "./sha256";
import { openTestDb, type TestDb } from "./testDb";

let t: TestDb;
beforeEach(async () => {
  t?.close();
  t = await openTestDb();
  t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'AI')");
  t.db.exec(
    "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
    " VALUES ('uid_q1', 1, NULL, 0, 'original text')");
});

describe("enqueueBatch", () => {
  test("persists wire JSON with batch_id and captures base_text_hash", () => {
    const res = enqueueBatch(t.db, [
      { op: "update_text", uid: "uid_q1", text: "edited once" },
    ], 99, "batch-aaaa");
    expect(res.pending).toBe(1);
    const row = t.db.select<{ batch_id: string; ops_json: string }>(
      "SELECT batch_id, ops_json FROM pending_ops")[0];
    expect(row.batch_id).toBe("batch-aaaa");
    const ops = JSON.parse(row.ops_json) as UpdateTextOp[];
    expect(ops[0].base_text_hash).toBe(sha256Hex("original text"));
    // optimistic apply happened
    expect(t.db.select("SELECT text FROM blocks WHERE uid='uid_q1'"))
      .toEqual([{ text: "edited once" }]);
  });

  test("chained edits hash against the previous local text, not the base", () => {
    enqueueBatch(t.db, [
      { op: "update_text", uid: "uid_q1", text: "v2" },
      { op: "update_text", uid: "uid_q1", text: "v3" },
    ], 99, "batch-bbbb");
    const ops = JSON.parse(t.db.select<{ ops_json: string }>(
      "SELECT ops_json FROM pending_ops")[0].ops_json) as UpdateTextOp[];
    expect(ops[0].base_text_hash).toBe(sha256Hex("original text"));
    expect(ops[1].base_text_hash).toBe(sha256Hex("v2"));
  });

  test("update of a block created in the same batch carries no base hash", () => {
    enqueueBatch(t.db, [
      { op: "create", uid: "uid_q2", page_title: "AI", parent_uid: null,
        order_idx: 1, text: "brand new" },
      { op: "update_text", uid: "uid_q2", text: "edited new" },
    ], 99, "batch-cccc");
    const ops = JSON.parse(t.db.select<{ ops_json: string }>(
      "SELECT ops_json FROM pending_ops")[0].ops_json) as UpdateTextOp[];
    expect(ops[1].base_text_hash).toBe(sha256Hex("brand new"));
  });

  test("empty ops enqueue nothing", () => {
    expect(enqueueBatch(t.db, [], 99, "batch-dddd").pending).toBe(0);
    expect(pendingCount(t.db)).toBe(0);
  });
});

describe("queue reads and lifecycle", () => {
  test("nextBatch is oldest-first and skips poisoned rows", () => {
    enqueueBatch(t.db, [{ op: "set_collapsed", uid: "uid_q1", collapsed: true }],
                 99, "batch-1");
    enqueueBatch(t.db, [{ op: "set_heading", uid: "uid_q1", heading: 1 }],
                 99, "batch-2");
    expect(nextBatch(t.db)?.batch_id).toBe("batch-1");
    const first = nextBatch(t.db)!;
    markPoisoned(t.db, first.id, "400: bad op");
    expect(nextBatch(t.db)?.batch_id).toBe("batch-2");
    expect(pendingCount(t.db)).toBe(1); // poisoned rows don't count
    expect(allBatches(t.db).length).toBe(2); // ...but recovery still sees them
    expect(allBatches(t.db)[0].poisoned).toBe(true);
  });

  test("deleteBatch removes the row and reports the remaining count", () => {
    enqueueBatch(t.db, [{ op: "delete", uid: "uid_q1" }], 99, "batch-1");
    const b = nextBatch(t.db)!;
    expect(deleteBatch(t.db, b.id)).toBe(0);
    expect(nextBatch(t.db)).toBeNull();
  });
});
