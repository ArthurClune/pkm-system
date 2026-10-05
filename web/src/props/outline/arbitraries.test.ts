import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isOutlinePaste, parseOutlineForest } from "../../outline/paste";
import type { BlockNode } from "../../api/payloads";
import { forestArb, renderForest, treeArb, type IndentStyle } from "./arbitraries";
import { treeProblems } from "./reading";

const STYLES: IndentStyle[] = ["two", "four", "tab", "bullet"];

function allBlocks(blocks: BlockNode[]): BlockNode[] {
  return blocks.flatMap((b) => [b, ...allBlocks(b.children)]);
}

describe("outline arbitraries", () => {
  it("generated trees are valid", () => {
    fc.assert(fc.property(treeArb, (t) => treeProblems(t).length === 0));
  });

  it("tree arbitrary reaches gaps, collapsed parents and empty text", () => {
    const trees = fc.sample(treeArb, 500);
    const gap = (t: BlockNode[]): boolean => {
      const walk = (sibs: BlockNode[]): boolean =>
        sibs.some((s, i) => (i > 0 && s.order_idx - sibs[i - 1].order_idx > 1) || walk(s.children));
      return walk(t);
    };
    const nonZeroFirst = (t: BlockNode[]): boolean => {
      const walk = (sibs: BlockNode[]): boolean =>
        sibs.some((s, i) => (i === 0 && s.order_idx !== 0) || walk(s.children));
      return walk(t);
    };
    expect(trees.some(gap)).toBe(true);
    expect(trees.some(nonZeroFirst)).toBe(true);
    expect(trees.some((t) => allBlocks(t).some((b) => b.collapsed && b.children.length > 0))).toBe(true);
    expect(trees.some((t) => allBlocks(t).some((b) => b.text === ""))).toBe(true);
    expect(trees.every((t) => allBlocks(t).length <= 30)).toBe(true);
  });

  it("rendered paste forests parse back to themselves", () => {
    fc.assert(fc.property(forestArb, fc.constantFrom(...STYLES), (f, s) => {
      expect(parseOutlineForest(renderForest(f, s))).toEqual(f);
    }));
  });

  it("every generated forest is an outline paste", () => {
    fc.assert(fc.property(forestArb, fc.constantFrom(...STYLES), (f, s) =>
      isOutlinePaste(renderForest(f, s))));
  });
});
