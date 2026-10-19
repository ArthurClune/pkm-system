// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { BlockUid, OrderIdx, RawTitle } from "../api/brands";
import type { BlockOp } from "../api/ops";
import { applyChanges } from "./apply";
import { applyLocalOps } from "./localOps";
import { setMeta } from "./meta";
import { skipsOnMissingTarget } from "./missingTarget";
import { enqueueBatch } from "./queue";
import { openTestDb } from "./testDb";
import { batchIdOf, orderIdxOf, rawTitleOf, seqOf, shaOf, uidOf } from "../test-helpers";

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

const HEADINGS = [1, 2, 3] as const;

const text = (raw: Raw, key: string): string => {
  const v = raw[key];
  if (typeof v !== "string") throw new Error(`fixture ${key} is not a string: ${JSON.stringify(v)}`);
  return v;
};
const int = (raw: Raw, key: string): number => {
  const v = raw[key];
  if (typeof v !== "number") throw new Error(`fixture ${key} is not a number: ${JSON.stringify(v)}`);
  return v;
};
const uidField = (raw: Raw, key: string): BlockUid => uidOf(text(raw, key));
const parentField = (raw: Raw): BlockUid | null => {
  if (raw.parent_uid === undefined) throw new Error("fixture row has no parent_uid");
  return raw.parent_uid === null ? null : uidField(raw, "parent_uid");
};
/** Throws on a key outside `allowed`, so a new fixture field is not dropped. */
const only = (raw: Raw, allowed: string[]): void => {
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) throw new Error(`fixture key ${k} is not one the minter knows`);
  }
};
const optionalTitle = (raw: Raw): { page_title?: RawTitle } =>
  raw.page_title === undefined ? {} : { page_title: rawTitleOf(text(raw, "page_title")) };

function mintOp(raw: Raw): BlockOp {
  switch (raw.op) {
    case "create":
      only(raw, ["op", "uid", "page_title", "parent_uid", "order_idx", "text"]);
      return { op: "create", uid: uidField(raw, "uid"), page_title: rawTitleOf(text(raw, "page_title")),
               parent_uid: parentField(raw), order_idx: orderIdxOf(int(raw, "order_idx")),
               text: text(raw, "text") };
    case "update_text":
      only(raw, ["op", "uid", "text", "base_text_hash"]);
      return { op: "update_text", uid: uidField(raw, "uid"), text: text(raw, "text"),
               ...(raw.base_text_hash === undefined ? {} : { base_text_hash: shaOf(text(raw, "base_text_hash")) }) };
    case "move":
      only(raw, ["op", "uid", "parent_uid", "order_idx", "page_title"]);
      return { op: "move", uid: uidField(raw, "uid"), parent_uid: parentField(raw),
               order_idx: orderIdxOf(int(raw, "order_idx")), ...optionalTitle(raw) };
    case "delete":
      only(raw, ["op", "uid"]);
      return { op: "delete", uid: uidField(raw, "uid") };
    case "set_collapsed":
      only(raw, ["op", "uid", "collapsed"]);
      if (typeof raw.collapsed !== "boolean") throw new Error("fixture collapsed is not a boolean");
      return { op: "set_collapsed", uid: uidField(raw, "uid"), collapsed: raw.collapsed };
    case "set_heading": {
      only(raw, ["op", "uid", "heading"]);
      const heading = HEADINGS.find((h) => h === raw.heading);
      if (heading === undefined) throw new Error(`fixture heading ${JSON.stringify(raw.heading)} is not 1-3`);
      return { op: "set_heading", uid: uidField(raw, "uid"), heading };
    }
    case "set_view_type":
      only(raw, ["op", "uid", "view_type"]);
      if (raw.view_type !== "numbered" && raw.view_type !== "document") {
        throw new Error(`fixture view_type ${JSON.stringify(raw.view_type)} is unknown`);
      }
      return { op: "set_view_type", uid: uidField(raw, "uid"), view_type: raw.view_type };
    case "create_page":
      only(raw, ["op", "page_title"]);
      return { op: "create_page", page_title: rawTitleOf(text(raw, "page_title")) };
    default:
      throw new Error(`fixture op ${String(raw.op)} is not one mintOp knows`);
  }
}

const placedOf = (raw: Raw): PlacedBlock => {
  only(raw, ["uid", "page", "parent_uid", "order_idx"]);
  return { uid: uidField(raw, "uid"), page: text(raw, "page"), parent_uid: parentField(raw),
           order_idx: orderIdxOf(int(raw, "order_idx")) };
};

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

      const placed = new Map(t.db.select(
        "SELECT b.uid, p.title AS page_title, b.parent_uid, b.order_idx" +
        " FROM blocks b JOIN pages p ON p.id = b.page_id", ["uid", "page_title", "parent_uid", "order_idx"],
      ).map((r): [string, PlacedBlock] => [r.uid,
        { uid: r.uid, page: r.page_title, parent_uid: r.parent_uid, order_idx: r.order_idx }]));
      const expected = c.expect.map(placedOf);
      expect(expected.map((e) => placed.get(e.uid))).toEqual(expected);
      for (const title of c.pages_absent) {
        expect(t.db.select("SELECT 1 AS n FROM pages WHERE title = ?", ["n"], [title]))
          .toEqual([]);
      }
    } finally {
      t.close();
    }
  });
});
