// @vitest-environment node
// pkm-t3qw: both replica paths that write block_refs go through one
// composition. apply.ts (remote apply: snapshot bootstrap and change windows)
// and localOps.ts (optimistic local apply) each used to hand-roll the same
// delete + re-derive loop. The delegation tests below fail if either one
// re-inlines it; the equivalence test fails if the two paths ever derive
// different rows from the same text, whatever code they run.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BlockOp } from "../api/ops";
import type { Changes, Snapshot, SyncBlock } from "./apply";
import { applyChanges, applySnapshot } from "./apply";
import { reindexBlockRefs } from "./blockRefs";
import { applyLocalOps } from "./localOps";
import { openTestDb, type TestDb } from "./testDb";

vi.mock("./blockRefs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./blockRefs")>();
  // a spy that still runs the real thing: delegation is counted, behaviour
  // stays exactly what the composition does
  return { ...actual, reindexBlockRefs: vi.fn(actual.reindexBlockRefs) };
});
const spy = vi.mocked(reindexBlockRefs);

// Texts covering what the composition owns: nothing, one target, duplicates,
// a dangling target, and a fenced ((uid)) the extractor strips.
const REF_TEXTS = [
  "no block refs here",
  "see ((uid_b1))",
  "((uid_b1)) twice: ((uid_b1))",
  "((uid_b1)) and ((uid_absent))",
  "```\n((uid_b1)) is quoted\n```",
];

const block = (uid: string, over: Partial<SyncBlock> = {}): SyncBlock => ({
  uid, page_id: 1, parent_uid: null, order_idx: 0, text: `text of ${uid}`,
  heading: null, view_type: null, collapsed: 0, created_at: 1, updated_at: 1,
  refs: [], ...over,
});

const SNAP: Snapshot = {
  generation: "gen-1", plain_space_title_canonicalization: false, seq: 10,
  pages: [{ id: 1, title: "AI", created_at: 1, updated_at: 1 }],
  blocks: [block("uid_b1"), block("uid_b2", { order_idx: 1 })],
  sidebar: [],
};

const feed = (blocks: SyncBlock[]): Changes => ({
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: 11, latest_seq: 11,
  pages: [], blocks, sidebar: [], tombstones: [],
});

let t: TestDb;
beforeEach(async () => {
  t?.close();
  t = await openTestDb();
  applySnapshot(t.db, SNAP);
  spy.mockClear();
});

const targets = (uid: string): string[] =>
  t.db.select<{ target_block_uid: string }>(
    "SELECT target_block_uid FROM block_refs WHERE src_block_uid = ?" +
    " ORDER BY target_block_uid", [uid]).map((r) => r.target_block_uid);

const updateText = (uid: string, text: string): void =>
  applyLocalOps(t.db, [{ op: "update_text", uid, text } as BlockOp], 7000);

describe("reindexBlockRefs", () => {
  test("replaces the block's rows and leaves other blocks alone", () => {
    reindexBlockRefs(t.db, "uid_b2", "((uid_b1))");
    reindexBlockRefs(t.db, "uid_b1", "((uid_b2))");
    reindexBlockRefs(t.db, "uid_b1", "no refs any more");

    expect(targets("uid_b1")).toEqual([]);
    expect(targets("uid_b2")).toEqual(["uid_b1"]);
  });

  test("keeps a dangling target and collapses duplicates", () => {
    reindexBlockRefs(t.db, "uid_b1", "((uid_absent)) ((uid_absent)) ((uid_b2))");

    expect(targets("uid_b1")).toEqual(["uid_absent", "uid_b2"]);
  });

  test("returns the parse so a caller can reuse it for refs", () => {
    const parsed = reindexBlockRefs(t.db, "uid_b1", "[[AI]] and ((uid_b2))");

    expect(parsed.refs).toEqual([{ title: "AI", kind: "link" }]);
    expect(parsed.blockRefs).toEqual(["uid_b2"]);
  });
});

describe("delegation", () => {
  test("remote apply reindexes through the composition (change window)", () => {
    applyChanges(t.db, feed([block("uid_b1", { text: "now ((uid_b2))" })]));

    expect(spy.mock.calls.map((c) => [c[1], c[2]]))
      .toEqual([["uid_b1", "now ((uid_b2))"]]);
    expect(targets("uid_b1")).toEqual(["uid_b2"]);
  });

  test("remote apply reindexes through the composition (snapshot)", () => {
    applySnapshot(t.db, {
      ...SNAP, blocks: [block("uid_b1", { text: "snap ((uid_b2))" })],
    });

    expect(spy.mock.calls.map((c) => [c[1], c[2]]))
      .toEqual([["uid_b1", "snap ((uid_b2))"]]);
    expect(targets("uid_b1")).toEqual(["uid_b2"]);
  });

  test("local op application reindexes through the composition", () => {
    updateText("uid_b1", "local ((uid_b2))");

    expect(spy.mock.calls.map((c) => [c[1], c[2]]))
      .toEqual([["uid_b1", "local ((uid_b2))"]]);
    expect(targets("uid_b1")).toEqual(["uid_b2"]);
  });

  test("a created block is reindexed through the composition too", () => {
    applyLocalOps(t.db, [{
      op: "create", uid: "uid_new1", page_title: "AI", parent_uid: null,
      order_idx: 5, text: "fresh ((uid_b1))",
    } as BlockOp], 7000);

    expect(spy.mock.calls.map((c) => [c[1], c[2]]))
      .toEqual([["uid_new1", "fresh ((uid_b1))"]]);
    expect(targets("uid_new1")).toEqual(["uid_b1"]);
  });
});

describe("remote and local apply agree", () => {
  test.each(REF_TEXTS)("derive the same block_refs from %j", (text) => {
    applyChanges(t.db, feed([block("uid_b1", { text })]));
    updateText("uid_b2", text);

    expect(targets("uid_b2")).toEqual(targets("uid_b1"));
  });
});
