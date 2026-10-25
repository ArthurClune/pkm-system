import { describe, expect, it } from "vitest";
import type { Snapshot, SyncBlock } from "../../replica/apply";
import type { BlockNode } from "../../api/payloads";
import type { NormalBlock, NormalGraph } from "../sync/normalise";
import { canonicalTitleOf, orderIdxOf, pageIdOf, seqOf, uidOf } from "../../test-helpers";
import { diffTrees, pruneGraph, pruneTree, treesFromSnapshot } from "./compare";

const node = (tag: string, order: number, children: BlockNode[] = [],
              extra: Partial<BlockNode> = {}): BlockNode => ({
  uid: uidOf(tag), text: tag, heading: null, view_type: null, collapsed: false,
  order_idx: orderIdxOf(order), created_at: null, updated_at: null, children, ...extra,
});

const sblock = (tag: string, page: number, parentTag: string | null,
                order: number, extra: Partial<SyncBlock> = {}): SyncBlock => ({
  uid: uidOf(tag), page_id: pageIdOf(page),
  parent_uid: parentTag === null ? null : uidOf(parentTag), order_idx: orderIdxOf(order),
  text: tag, heading: null, view_type: null, collapsed: 0, created_at: 1, updated_at: 2,
  refs: [], ...extra,
});

const snap = (blocks: SyncBlock[]): Snapshot => ({
  generation: "gen-1", plain_space_title_canonicalization: false, seq: seqOf(1),
  pages: [
    { id: pageIdOf(1), title: canonicalTitleOf("A"), created_at: 1, updated_at: 1 },
    { id: pageIdOf(2), title: canonicalTitleOf("B"), created_at: 1, updated_at: 1 },
  ],
  blocks,
  sidebar: [],
});

const nb = (key: string, page: string, parentKey: string | null, order: number,
            refs: string[] = []): NormalBlock => ({
  key, page, parentKey, order_idx: orderIdxOf(order), text: key, heading: null, collapsed: 0,
  view_type: null, refs,
});

describe("treesFromSnapshot", () => {
  it("builds per-page trees in key order with exact keys, empty for absent pages", () => {
    const s = snap([
      sblock("opsb01", 1, null, 40),
      sblock("opsb00", 1, null, 10),
      sblock("opsb02", 1, "opsb00", 7),
      sblock("opsb03", 1, "opsb00", 3),
      sblock("opsb04", 2, null, 5),
    ]);
    const t = treesFromSnapshot(s, ["A", "B", "C"]);
    expect([...t.keys()]).toEqual(["A", "B", "C"]);
    expect(t.get("A")!.map((n) => [n.uid, n.order_idx])).toEqual([["opsb00", 10], ["opsb01", 40]]);
    expect(t.get("A")![0].children.map((n) => [n.uid, n.order_idx]))
      .toEqual([["opsb03", 3], ["opsb02", 7]]);
    expect(t.get("A")![0].created_at).toBeNull();
    expect(t.get("B")!.map((n) => n.uid)).toEqual(["opsb04"]);
    expect(t.get("C")).toEqual([]);
  });
});

describe("treesFromSnapshot input checks", () => {
  it("throws on unreachable rows", () => {
    for (const bad of [sblock("opsb09", 1, "nowhere", 1), sblock("opsb09", 1, "opsb09", 1),
                       sblock("opsb09", 1, "opsb08", 1)]) {
      const rows = [sblock("opsb00", 1, null, 1), bad,
                    ...(bad.parent_uid === uidOf("opsb08") ? [sblock("opsb08", 2, null, 1)] : [])];
      expect(() => treesFromSnapshot(snap(rows), ["A"])).toThrow(/page "A".*opsb09/);
    }
  });
  it("throws on two pages with one title", () => {
    const s = snap([]);
    s.pages.push({ id: pageIdOf(3), title: canonicalTitleOf("A"), created_at: 1, updated_at: 1 });
    expect(() => treesFromSnapshot(s, ["A"])).toThrow(/two pages titled "A"/);
  });
});

describe("diffTrees", () => {
  it("compares a long text by value and names it by length and hash", () => {
    const long = (end: string) => [node("opsb00", 1, [], { text: "y".repeat(300) + end })];
    expect(diffTrees(long(""), long(""), ["server", "tree"])).toEqual([]);
    const [line] = diffTrees(long("a"), long("b"), ["server", "tree"]);
    expect(line).toMatch(/^opsb00: text <301 UTF-16 units, sha256 [0-9a-f]{16}> \(server\) vs/);
  });


  it("reports a uid appearing twice in one tree", () => {
    const a = [node("opsb00", 1), node("opsb00", 2)];
    expect(diffTrees(a, [node("opsb00", 1)], ["server", "tree"]))
      .toContain("opsb00: duplicated in server");
  });
  const names: [string, string] = ["server", "tree"];
  it("is empty for equal trees", () => {
    expect(diffTrees([node("opsb00", 1)], [node("opsb00", 1)], names)).toEqual([]);
  });
  it("reports a key drift that keeps order as order_idx only", () => {
    const a = [node("opsb00", 1), node("opsb03", 4)];
    const b = [node("opsb00", 1), node("opsb03", 5)];
    expect(diffTrees(a, b, names)).toEqual(["opsb03: order_idx 4 (server) vs 5 (tree)"]);
  });
  it("reports a swap as position and order_idx", () => {
    const a = [node("opsb00", 1), node("opsb01", 2)];
    const b = [node("opsb01", 1), node("opsb00", 2)];
    const lines = diffTrees(a, b, names);
    expect(lines).toContain("opsb00: position 0 (server) vs 1 (tree)");
    expect(lines).toContain("opsb01: position 1 (server) vs 0 (tree)");
    expect(lines).toContain("opsb00: order_idx 1 (server) vs 2 (tree)");
  });
  it("reports missing, parent and field differences", () => {
    const a = [node("opsb00", 1, [node("opsb01", 1)]), node("opsb02", 2)];
    const b = [node("opsb00", 1), node("opsb01", 1, [], { text: "x", collapsed: true })];
    const lines = diffTrees(a, b, names);
    expect(lines).toContain("opsb02: only in server");
    expect(lines).toContain('opsb01: parent "opsb00" (server) vs null (tree)');
    expect(lines).toContain('opsb01: text "opsb01" (server) vs "x" (tree)');
    expect(lines).toContain("opsb01: collapsed false (server) vs true (tree)");
    expect(diffTrees([], [node("opsb09", 1)], names)).toEqual(["opsb09: only in tree"]);
  });
});

describe("pruneTree", () => {
  it("drops an unknown node with its subtree", () => {
    const t = [node("opsb00", 1, [node("opsb01", 1)]),
               node("minted", 2, [node("opsb02", 1)])];
    const out = pruneTree(t, new Set(["opsb00", "opsb01", "opsb02"]));
    expect(out.map((n) => n.uid)).toEqual(["opsb00"]);
    expect(out[0].children.map((n) => n.uid)).toEqual(["opsb01"]);
  });
});

describe("pruneGraph", () => {
  it("drops minted blocks and pages nothing kept uses, keeping keepPages", () => {
    const g: NormalGraph = {
      pages: ["Conflict", "Daily", "Kept", "Mine", "New", "Ref:d", "Ref:x"],
      blocks: [
        nb("opsb00", "Mine", null, 1, ["link:Ref:d"]),
        nb("minted", "Daily", null, 1, ["link:Ref:x"]),
        nb("minted2", "Conflict", null, 1),
      ],
    };
    const out = pruneGraph(g, new Set(["opsb00"]), new Set(["New", "Kept"]));
    expect(out.pages).toEqual(["Kept", "Mine", "New", "Ref:d"]);
    expect(out.blocks.map((b) => b.key)).toEqual(["opsb00"]);
  });
  it("carries the graph's other fields through", () => {
    const g: NormalGraph = {
      pages: ["Mine"], blocks: [nb("opsb00", "Mine", null, 1)],
      pageStamps: { Mine: "1/2" },
    };
    expect(pruneGraph(g, new Set(["opsb00"]), new Set()).pageStamps)
      .toEqual({ Mine: "1/2" });
  });
});
