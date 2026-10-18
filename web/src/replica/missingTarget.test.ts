// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { BlockUid, OrderIdx } from "../api/brands";
import type { BlockOp } from "../api/ops";
import { applyChanges } from "./apply";
import { applyLocalOps } from "./localOps";
import { setMeta } from "./meta";
import { skipsOnMissingTarget } from "./missingTarget";
import { enqueueBatch } from "./queue";
import { openTestDb } from "./testDb";
import { batchIdOf, malformedUid, orderIdxOf, seqOf, shaOf, uidOf } from "../test-helpers";

// The fixture's JSON, as it is on disk: plain values, no brands. `mintOp`
// and `placedOf` turn a row into the typed shape the code under test takes.
type Raw = Record<string, string | number | boolean | null>;

interface MissingTargetCase {
  name: string;
  op: Raw;
  block_exists: boolean;
  parent_exists: boolean;
  parent_chain?: string[];
  skip: boolean;
}

interface PlacementCase {
  name: string;
  ops: Raw[];
  replay: boolean;
  expect: Raw[];
  pages_absent: string[];
}

interface PlacedBlock {
  uid: BlockUid;
  page: string;
  parent_uid: BlockUid | null;
  order_idx: OrderIdx;
}

const fixture = JSON.parse(readFileSync(new URL(
  "../../../shared/fixtures/missing_targets.json", import.meta.url,
), "utf-8")) as {
  cases: MissingTargetCase[];
  placement_state: { pages: { id: number; title: string }[];
                     blocks: Raw[] };
  placement_cases: PlacementCase[];
};

// The one fixture uid below the BlockUid shape's minimum length. The case it
// is in only asks whether a move plans, which the shape does not touch, and
// the file is shared with the server's test, so the value stays as it is.
const SHORT_FIXTURE_UID = "uid_p";

const fixtureUid = (v: Raw[string]): BlockUid =>
  v === SHORT_FIXTURE_UID ? malformedUid(v) : uidOf(String(v));

const parentOf = (v: Raw[string] | undefined): BlockUid | null =>
  v === null || v === undefined ? null : fixtureUid(v);

const HEADINGS = [1, 2, 3] as const;

function mintOp(raw: Raw): BlockOp {
  const uid = uidOf(String(raw.uid));
  const pageTitle = raw.page_title === undefined ? {} : { page_title: String(raw.page_title) };
  switch (raw.op) {
    case "create":
      return { op: "create", uid, page_title: String(raw.page_title), parent_uid: parentOf(raw.parent_uid),
               order_idx: orderIdxOf(Number(raw.order_idx)), text: String(raw.text) };
    case "update_text":
      return { op: "update_text", uid, text: String(raw.text),
               ...(raw.base_text_hash === undefined ? {} : { base_text_hash: shaOf(String(raw.base_text_hash)) }) };
    case "move":
      return { op: "move", uid, parent_uid: parentOf(raw.parent_uid),
               order_idx: orderIdxOf(Number(raw.order_idx)), ...pageTitle };
    case "delete":
      return { op: "delete", uid };
    case "set_collapsed":
      return { op: "set_collapsed", uid, collapsed: raw.collapsed === true };
    case "set_heading":
      return { op: "set_heading", uid, heading: HEADINGS.find((h) => h === raw.heading) ?? null };
    case "set_view_type":
      return { op: "set_view_type", uid, view_type: raw.view_type === "numbered" ? "numbered" : "document" };
    case "create_page":
      return { op: "create_page", page_title: String(raw.page_title) };
    default:
      throw new Error(`fixture op ${String(raw.op)} is not one mintOp knows`);
  }
}

const placedOf = (raw: Raw): PlacedBlock => ({
  uid: uidOf(String(raw.uid)), page: String(raw.page), parent_uid: parentOf(raw.parent_uid),
  order_idx: orderIdxOf(Number(raw.order_idx)),
});

describe("skipsOnMissingTarget", () => {
  test.each(fixture.cases)("$name", ({ op, block_exists, parent_exists,
                                       parent_chain = [], skip }) => {
    expect(skipsOnMissingTarget(mintOp(op), block_exists, parent_exists, parent_chain))
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
      for (const b of fixture.placement_state.blocks.map(placedOf)) {
        t.db.exec(
          "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
          " VALUES (?,?,?,?,?)",
          [b.uid, pageIds.get(b.page)!, b.parent_uid, b.order_idx, b.uid]);
      }

      if (c.replay) {
        setMeta(t.db, "generation", "gen-1");
        enqueueBatch(t.db, c.ops.map(mintOp), 99, batchIdOf("t"));
        expect(applyChanges(t.db, {
          reset: false, generation: "gen-1",
          plain_space_title_canonicalization: false,
          next_since: seqOf(1), latest_seq: seqOf(1),
          pages: [], blocks: [], sidebar: [], tombstones: [],
        }, 100)).toEqual({ status: "applied", cursor: 1 });
      } else {
        applyLocalOps(t.db, c.ops.map(mintOp), 99, { batchId: batchIdOf("t") });
      }

      const placed = new Map(t.db.select<"uid" | "page_title" | "parent_uid" | "order_idx">(
        "SELECT b.uid, p.title AS page_title, b.parent_uid, b.order_idx" +
        " FROM blocks b JOIN pages p ON p.id = b.page_id",
      ).map((r): [string, PlacedBlock] => [r.uid,
        { uid: r.uid, page: r.page_title, parent_uid: r.parent_uid, order_idx: r.order_idx }]));
      const expected = c.expect.map(placedOf);
      expect(expected.map((e) => placed.get(e.uid))).toEqual(expected);
      for (const title of c.pages_absent) {
        expect(t.db.select("SELECT 1 AS x FROM pages WHERE title = ?", [title]))
          .toEqual([]);
      }
    } finally {
      t.close();
    }
  });
});
