import { describe, expect, it } from "vitest";
import type { BlockUid, OrderIdx } from "../../api/brands";
import type { BlockNode } from "../../api/payloads";
import { readingRows, rowsDiff, structural, treeProblems } from "./reading";

const node = (uid: string, order: number, over: Partial<BlockNode> = {},
              children: BlockNode[] = []): BlockNode => ({
  uid: uid as BlockUid, text: uid, heading: null, view_type: null, collapsed: false,
  order_idx: order as OrderIdx, created_at: null, updated_at: null, children,
  ...over,
});

describe("readingRows", () => {
  it("flattens depth-first and marks collapsed descendants hidden", () => {
    const tree = [
      node("a", 0, {}, [
        node("b", 0, { collapsed: true }, [node("c", 0), node("d", 1)]),
        node("e", 1),
      ]),
      node("f", 1),
    ];
    const rows = readingRows(tree);
    expect(rows.map((r) => [r.uid, r.depth, r.hidden])).toEqual([
      ["a", 0, false], ["b", 1, false], ["c", 2, true], ["d", 2, true],
      ["e", 1, false], ["f", 0, false],
    ]);
    expect(rows[1].collapsed).toBe(true);
  });
});

describe("structural", () => {
  it("ignores collapsed and treats a null view type as document", () => {
    const rows = readingRows([node("a", 0, { collapsed: true, heading: 2 })]);
    const other = readingRows([node("a", 0, { heading: 2, view_type: "document" })]);
    expect(structural(rows)).toEqual(structural(other));
    expect(structural(rows)).toHaveLength(1);
  });
});

describe("treeProblems", () => {
  it("names a duplicate uid", () => {
    const problems = treeProblems([node("a", 0, {}, [node("a", 0)])]);
    expect(problems.join("\n")).toContain("duplicate uid a");
  });

  it("names equal sibling order keys", () => {
    const problems = treeProblems([node("a", 1), node("b", 1)]);
    expect(problems.join("\n")).toMatch(/order_idx/);
  });

  it("names siblings not sorted by order_idx", () => {
    const problems = treeProblems([node("a", 5), node("b", 2)]);
    expect(problems.length).toBeGreaterThan(0);
  });

  it("accepts gaps", () => {
    expect(treeProblems([node("a", 0), node("b", 3), node("c", 7)])).toEqual([]);
  });
});

describe("rowsDiff", () => {
  it("points at the first differing row", () => {
    const a = readingRows([node("a", 0), node("b", 1), node("c", 2)]);
    const b = readingRows([node("a", 0), node("x", 1), node("y", 2)]);
    expect(rowsDiff(a, a)).toBeNull();
    const diff = rowsDiff(a, b) ?? "";
    expect(diff).toContain("row 1");
    expect(diff).toContain("\"b\"");
    expect(diff).toContain("\"x\"");
    expect(rowsDiff(a, a.slice(0, 2))).toContain("length");
  });
});
