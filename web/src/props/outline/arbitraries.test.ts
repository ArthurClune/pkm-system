import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isOutlinePaste, parseOutlineForest } from "../../outline/paste";
import type { BlockNode } from "../../api/payloads";
import { commandArb, forestArb, sequenceArb, renderForest, treeArb, type IndentStyle } from "./arbitraries";
import { runSequence } from "./run";
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
    expect(trees.some((t) => allBlocks(t).length > 20)).toBe(true);
    expect(fc.sample(sequenceArb, 500).some((q) => q.commands.length > 15)).toBe(true);
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

  it("command kinds are weighted evenly apart from undo, redo and paste", () => {
    const counts = new Map<string, number>();
    const n = 20000;
    for (const c of fc.sample(commandArb, n)) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
    const share = (k: string): number => (counts.get(k) ?? 0) / n;
    const special = new Set(["undo", "redo", "paste"]);
    const edits = [...counts.keys()].filter((k) => !special.has(k));
    expect(edits).toHaveLength(18);
    for (const k of edits) {
      expect(share(k)).toBeGreaterThan(0.03);
      expect(share(k)).toBeLessThan(0.06);
    }
    expect(share("undo") + share("redo")).toBeGreaterThan(0.12);
    expect(share("undo") + share("redo")).toBeLessThan(0.17);
    expect(share("paste")).toBeGreaterThan(0.06);
    expect(share("paste")).toBeLessThan(0.10);
  });

  it("selections and drops reach small spans that change the tree", () => {
    const seen = { selDown: [0, 0], outdentSel: [0, 0], drop: [0, 0] };
    for (const { start, commands } of fc.sample(sequenceArb, 300)) {
      for (const step of runSequence(start, commands).steps) {
        const k = step.command.kind;
        if (k !== "selDown" && k !== "outdentSel" && k !== "drop") continue;
        seen[k][0]++;
        if (k === "drop") {
          if (step.resolved?.kind === "drop" && step.resolved.uids.length === 1) seen[k][1]++;
        } else if (step.ops.length > 0) seen[k][1]++;
      }
    }
    expect(seen.selDown[1] / seen.selDown[0]).toBeGreaterThan(0.1);
    expect(seen.outdentSel[1] / seen.outdentSel[0]).toBeGreaterThan(0.1);
    expect(seen.drop[1] / seen.drop[0]).toBeGreaterThan(0.2);
  });
});
