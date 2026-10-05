import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../replica/apply";
import type { BlockNode } from "../../api/payloads";
import type { NormalBlock, NormalGraph } from "../sync/normalise";
import { diffTrees, pruneGraph, pruneTree, treesFromSnapshot } from "./compare";

const node = (uid: string, order_idx: number, children: BlockNode[] = [],
              extra: Partial<BlockNode> = {}): BlockNode => ({
  uid, text: uid, heading: null, view_type: null, collapsed: false,
  order_idx, created_at: null, updated_at: null, children, ...extra,
} as unknown as BlockNode);

const sblock = (uid: string, page_id: number, parent_uid: string | null,
                order_idx: number, extra: object = {}) => ({
  uid, page_id, parent_uid, order_idx, text: uid, heading: null, view_type: null,
  collapsed: 0, created_at: 1, updated_at: 2, refs: [], ...extra,
});

const snap = (blocks: object[]): Snapshot => ({
  pages: [
    { id: 1, title: "A", created_at: 1, updated_at: 1 },
    { id: 2, title: "B", created_at: 1, updated_at: 1 },
  ],
  blocks,
} as unknown as Snapshot);

const nb = (uid: string, page: string, parent_uid: string | null, order_idx: number,
            refs: string[] = []): NormalBlock => ({
  uid, page, parent_uid, order_idx, text: uid, heading: null, collapsed: 0,
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
                    ...(bad.parent_uid === "opsb08" ? [sblock("opsb08", 2, null, 1)] : [])];
      expect(() => treesFromSnapshot(snap(rows), ["A"])).toThrow(/page "A".*opsb09/);
    }
  });
  it("throws on two pages with one title", () => {
    const s = snap([]);
    s.pages.push({ id: 3, title: "A", created_at: 1, updated_at: 1 } as never);
    expect(() => treesFromSnapshot(s, ["A"])).toThrow(/two pages titled "A"/);
  });
});

describe("diffTrees", () => {
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
    expect(out.blocks.map((b) => b.uid)).toEqual(["opsb00"]);
  });
});
