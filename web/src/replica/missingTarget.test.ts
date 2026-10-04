// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { BatchId } from "../api/brands";
import type { BlockOp } from "../api/ops";
import { applyLocalOps } from "./localOps";
import { skipsOnMissingTarget } from "./missingTarget";
import { openTestDb } from "./testDb";

interface MissingTargetCase {
  name: string;
  op: BlockOp;
  block_exists: boolean;
  parent_exists: boolean;
  parent_chain?: string[];
  skip: boolean;
}

interface PlacedBlock {
  uid: string;
  page: string;
  parent_uid: string | null;
  order_idx: number;
}

interface PlacementCase {
  name: string;
  ops: BlockOp[];
  replay: boolean;
  replica_only: PlacedBlock[];
  expect: PlacedBlock[];
  pages_absent: string[];
}

const fixture = JSON.parse(readFileSync(new URL(
  "../../../shared/fixtures/missing_targets.json", import.meta.url,
), "utf-8")) as {
  cases: MissingTargetCase[];
  placement_state: { pages: { id: number; title: string }[];
                     blocks: PlacedBlock[] };
  placement_cases: PlacementCase[];
};

describe("skipsOnMissingTarget", () => {
  test.each(fixture.cases)("$name", ({ op, block_exists, parent_exists,
                                       parent_chain = [], skip }) => {
    expect(skipsOnMissingTarget(op, block_exists, parent_exists, parent_chain))
      .toBe(skip);
  });
});

// Where a create or move lands in the replica's local apply, pinned to the
// same table the server's write path passes (test_ops_core.py), so an
// optimistic placement is the one the feed later confirms. replica_only
// rows are this replica's own earlier apply of the ops (a row for a shared
// uid replaces it: the earlier apply shifted it), which a replay (reapply)
// finds already in place.
describe("applyLocalOps placement agrees with the server", () => {
  test.each(fixture.placement_cases)("$name", async (c) => {
    const t = await openTestDb();
    try {
      const pageIds = new Map(
        fixture.placement_state.pages.map((p) => [p.title, p.id]));
      for (const [title, id] of pageIds) {
        t.db.exec("INSERT INTO pages(id, title) VALUES (?, ?)", [id, title]);
      }
      const own = new Set(c.replica_only.map((b) => b.uid));
      for (const b of [
        ...fixture.placement_state.blocks.filter((b) => !own.has(b.uid)),
        ...c.replica_only,
      ]) {
        t.db.exec(
          "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
          " VALUES (?,?,?,?,?)",
          [b.uid, pageIds.get(b.page)!, b.parent_uid, b.order_idx, b.uid]);
      }

      applyLocalOps(t.db, c.ops, 99, { batchId: "t" as BatchId, reapply: c.replay });

      const placed = new Map(t.db.select<PlacedBlock>(
        "SELECT b.uid, p.title AS page, b.parent_uid, b.order_idx" +
        " FROM blocks b JOIN pages p ON p.id = b.page_id",
      ).map((r) => [r.uid, { ...r }]));
      expect(c.expect.map((e) => placed.get(e.uid))).toEqual(c.expect);
      for (const title of c.pages_absent) {
        expect(t.db.select("SELECT 1 AS x FROM pages WHERE title = ?", [title]))
          .toEqual([]);
      }
    } finally {
      t.close();
    }
  });
});
