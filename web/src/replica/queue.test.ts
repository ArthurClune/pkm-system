// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type { BlockOp, UpdateTextOp } from "../api/ops";
import { LocalOpError } from "./localOps";
import * as queue from "./queue";
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

const durableAndOptimisticState = () => ({
  pending: t.db.select("SELECT * FROM pending_ops ORDER BY id"),
  pages: t.db.select("SELECT * FROM pages ORDER BY id"),
  blocks: t.db.select("SELECT * FROM blocks ORDER BY uid"),
  refs: t.db.select(
    "SELECT * FROM refs ORDER BY src_block_uid, target_page_id, kind"),
  sidebar: t.db.select("SELECT * FROM sidebar_entries ORDER BY id"),
  metadata: t.db.select("SELECT * FROM sync_client_meta ORDER BY key"),
});

describe("enqueueBatch", () => {
  test.each([
    ["explicit page title", { op: "create_page", page_title: "Queue #Bad" },
      "page_title", "Queue #Bad"],
    ["extracted reference", { op: "update_text", uid: "uid_q1",
      text: "[[Queue #Bad Ref]]" }, "reference", "Queue #Bad Ref"],
  ] as const)("refuses a full batch atomically for a later forbidden %s",
    (_name, invalidOp, source, title) => {
      const before = durableAndOptimisticState();
      let thrown: unknown;

      try {
        enqueueBatch(t.db, [
          { op: "update_text", uid: "uid_q1", text: "would partially apply" },
          invalidOp as BlockOp,
        ], 99, "batch-invalid");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LocalOpError);
      expect(thrown).toMatchObject({ opIndex: 1, source, title });
      expect(durableAndOptimisticState()).toEqual(before);
      expect(pendingCount(t.db)).toBe(0);
    });

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

  test("preserves an explicit base_text_hash", () => {
    enqueueBatch(t.db, [{
      op: "update_text",
      uid: "uid_q1",
      text: "linked snapshot",
      base_text_hash: "snapshot-hash",
    }], 99, "batch-explicit");

    const ops = JSON.parse(t.db.select<{ ops_json: string }>(
      "SELECT ops_json FROM pending_ops")[0].ops_json) as UpdateTextOp[];
    expect(ops[0].base_text_hash).toBe("snapshot-hash");
    expect(t.db.select("SELECT text FROM blocks WHERE uid='uid_q1'"))
      .toEqual([{ text: "linked snapshot" }]);
  });

  test("persists even when optimistic apply cannot (un-hydrated blocks)", () => {
    // during the bootstrap window the user edits server-rendered blocks the
    // replica hasn't hydrated yet: the local apply is best-effort, but the
    // batch MUST persist — dropping it loses the edit
    const res = enqueueBatch(t.db, [
      { op: "update_text", uid: "uid_ghost", text: "edited before hydration" },
      { op: "create", uid: "uid_orphan", page_title: "AI",
        parent_uid: "uid_ghost2", order_idx: 0, text: "child of a ghost" },
      { op: "update_text", uid: "uid_q1", text: "this one applies" },
    ], 99, "batch-ghost");
    expect(res.pending).toBe(1);
    const batch = nextBatch(t.db)!;
    expect(batch.ops).toHaveLength(3);
    // the un-hydrated update carries no base hash: plain LWW at the server
    expect((batch.ops[0] as UpdateTextOp).base_text_hash).toBeUndefined();
    // the appliable op in the same batch still applied locally
    expect(t.db.select("SELECT text FROM blocks WHERE uid='uid_q1'"))
      .toEqual([{ text: "this one applies" }]);
    // the skipped ops left no partial rows behind
    expect(t.db.select("SELECT uid FROM blocks WHERE uid='uid_orphan'"))
      .toEqual([]);
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

  test("enqueueBatch fills page_title from the replica when absent", () => {
    enqueueBatch(t.db, [
      { op: "update_text", uid: "uid_q1", text: "edited once" },
    ], 99, "batch-title");
    const ops = JSON.parse(t.db.select<{ ops_json: string }>(
      "SELECT ops_json FROM pending_ops")[0].ops_json) as UpdateTextOp[];
    expect(ops[0].page_title).toBe("AI");
  });

  test("leaves an unknown block's op without a page_title", () => {
    enqueueBatch(t.db, [
      { op: "update_text", uid: "uid_ghost", text: "edited before hydration" },
    ], 99, "batch-title-ghost");
    const ops = JSON.parse(t.db.select<{ ops_json: string }>(
      "SELECT ops_json FROM pending_ops")[0].ops_json) as UpdateTextOp[];
    expect(ops[0].page_title).toBeUndefined();
  });

  test("preserves an explicit page_title", () => {
    enqueueBatch(t.db, [{
      op: "update_text", uid: "uid_q1", text: "edited",
      page_title: "Explicit Page",
    }], 99, "batch-title-explicit");
    const ops = JSON.parse(t.db.select<{ ops_json: string }>(
      "SELECT ops_json FROM pending_ops")[0].ops_json) as UpdateTextOp[];
    expect(ops[0].page_title).toBe("Explicit Page");
  });

  test("a caller-hashed op is persisted exactly as the lane would keep it", () => {
    // opQueue's fallback lane retains the ops as the caller passed them, so
    // a lost enqueue reply leaves two copies of one batch_id; they must be
    // byte-identical or the second delivery 409s instead of replaying
    const ops: BlockOp[] = [{
      op: "update_text", uid: "uid_q1", text: "linked",
      base_text_hash: sha256Hex("original text"),
    }];
    enqueueBatch(t.db, ops, 99, "batch-lane-copy");
    expect(t.db.select<{ ops_json: string }>(
      "SELECT ops_json FROM pending_ops")[0].ops_json)
      .toBe(JSON.stringify(ops));
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
    markPoisoned(t.db, first.id, "400: bad op", first.batch_id);
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

  test("durable poison details can be discovered after startup", () => {
    enqueueBatch(t.db, [{ op: "update_text", uid: "uid_q1", text: "bad" }],
                 99, "batch-rejected");
    const rejected = nextBatch(t.db)!;
    markPoisoned(t.db, rejected.id, JSON.stringify({
      status: 422, message: "request failed: 422 /api/ops",
    }), "batch-rejected");

    expect("poisonedBatches" in queue).toBe(true);
    const poisonedBatches = (queue as unknown as {
      poisonedBatches(db: typeof t.db): unknown[];
    }).poisonedBatches;
    expect(poisonedBatches(t.db)).toEqual([{
      rowId: rejected.id,
      batchId: "batch-rejected",
      ops: rejected.ops,
      status: 422,
      message: "request failed: 422 /api/ops",
    }]);

    // Rows written before typed poison metadata shipped stored Error#toString.
    t.db.exec("UPDATE pending_ops SET error = ? WHERE id = ?", [
      "ApiError: request failed: 409 /api/ops", rejected.id,
    ]);
    expect(poisonedBatches(t.db)[0]).toMatchObject({
      status: 409, message: "ApiError: request failed: 409 /api/ops",
    });
  });
});

describe("importPendingRows", () => {
  const readRows = () => t.db.select(
    "SELECT id, batch_id, ops_json, poisoned, error FROM pending_ops ORDER BY id");

  test("importPendingRows keeps ids verbatim and later enqueues number past them", () => {
    const rows = [
      { id: 4, batch_id: "b4", ops_json: JSON.stringify([{ op: "delete", uid: "uid_a" }]),
        poisoned: 1, error: "HTTP 400" },
      { id: 7, batch_id: "b7", ops_json: JSON.stringify([{ op: "delete", uid: "uid_b" }]),
        poisoned: 0, error: null },
    ];
    queue.importPendingRows(t.db, rows);
    expect(readRows()).toEqual(rows);
    enqueueBatch(t.db, [{ op: "delete", uid: "uid_x" }], 10, "after");
    expect(t.db.select<{ id: number }>(
      "SELECT id FROM pending_ops WHERE batch_id = 'after'")).toEqual([{ id: 8 }]);
  });

  test("importPendingRows ignores a row whose id is already present", () => {
    t.db.exec("INSERT INTO pending_ops(id, batch_id, ops_json) VALUES (1, 'kept', '[]')");
    queue.importPendingRows(t.db, [
      { id: 1, batch_id: "other", ops_json: "[]", poisoned: 0, error: null },
    ]);
    expect(t.db.select("SELECT batch_id FROM pending_ops WHERE id = 1"))
      .toEqual([{ batch_id: "kept" }]);
  });
});
