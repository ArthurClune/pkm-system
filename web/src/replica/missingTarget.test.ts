// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { BatchId, SyncSeq } from "../api/brands";
import type { BlockOp } from "../api/ops";
import { applyChanges } from "./apply";
import { applyLocalOps } from "./localOps";
import { setMeta } from "./meta";
import { skipsOnMissingTarget } from "./missingTarget";
import { enqueueBatch } from "./queue";
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
// optimistic placement is the one the feed later confirms. A replay case
// enqueues the ops and then applies a feed window that ships nothing, so
// the window rewinds the batch and replays it as a first apply.
describe("applyLocalOps placement agrees with the server", () => {
  test.each(fixture.placement_cases)("$name", async (c) => {
    const t = await openTestDb();
    try {
      const pageIds = new Map(
        fixture.placement_state.pages.map((p) => [p.title, p.id]));
      for (const [title, id] of pageIds) {
        t.db.exec("INSERT INTO pages(id, title) VALUES (?, ?)", [id, title]);
      }
      for (const b of fixture.placement_state.blocks) {
        t.db.exec(
          "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
          " VALUES (?,?,?,?,?)",
          [b.uid, pageIds.get(b.page)!, b.parent_uid, b.order_idx, b.uid]);
      }

      if (c.replay) {
        setMeta(t.db, "generation", "gen-1");
        enqueueBatch(t.db, c.ops, 99, "t" as BatchId);
        expect(applyChanges(t.db, {
          reset: false, generation: "gen-1",
          plain_space_title_canonicalization: false,
          next_since: 1 as SyncSeq, latest_seq: 1 as SyncSeq,
          pages: [], blocks: [], sidebar: [], tombstones: [],
        }, 100)).toEqual({ status: "applied", cursor: 1 });
      } else {
        applyLocalOps(t.db, c.ops, 99, { batchId: "t" as BatchId });
      }

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
