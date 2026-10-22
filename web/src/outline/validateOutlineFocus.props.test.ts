// validateOutlineFocus over generated trees, focuses and texts: the focus it
// hands back is always one the editor can show, with a caret inside the text.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { BlockUid } from "../api/brands";
import type { BlockNode } from "../api/payloads";
import { uidOf } from "../test-helpers";
import { validateOutlineFocus } from "./outlineState";
import { visibleUids } from "./tree";
import { allNodes, isTable, pathTo, treeArb } from "../props/outline/visibleTree";

const insidePair = (text: string, at: number): boolean =>
  at > 0 && at < text.length
  && text.charCodeAt(at - 1) >= 0xd800 && text.charCodeAt(at - 1) <= 0xdbff
  && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff;

const caseArb = fc.record({
  tree: treeArb,
  pick: fc.nat(),
  gone: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
  cursor: fc.oneof(fc.nat({ max: 12 }), fc.constant(0)),
  mid: fc.boolean(),
});

describe("validateOutlineFocus", () => {
  test("names a visible block with the caret inside its text", () => {
    const tally = { gone: 0, hidden: 0, past: 0, midPair: 0, kept: 0, tableCell: 0 };
    fc.assert(fc.property(caseArb, ({ tree, pick, gone, cursor: drawn, mid }) => {
      const nodes = allNodes(tree);
      const target = gone ? uidOf("tuid-missing") : nodes[pick % nodes.length].uid;
      // Half the draws put the caret inside a surrogate pair when the block
      // holds one, the offset an undo restores onto changed text.
      const own = nodes.find((n) => n.uid === target)?.text ?? "";
      const inside = [...own].length === own.length ? -1 : own.search(/[\uD800-\uDBFF][\uDC00-\uDFFF]/) + 1;
      const cursor = mid && inside > 0 ? inside : drawn;
      const focus = { uid: target, cursor };
      const result = validateOutlineFocus(focus, tree);
      const visible = visibleUids(tree);
      const text = (id: BlockUid): string =>
        nodes.find((n) => n.uid === id)!.text;

      if (gone) {
        expect(result).toBeNull();
        tally.gone += 1;
        return;
      }
      expect(result).not.toBeNull();
      if (!result) return;
      expect(visible).toContain(result.uid);
      expect(Number.isInteger(result.cursor)).toBe(true);
      expect(result.cursor).toBeGreaterThanOrEqual(0);
      expect(result.cursor).toBeLessThanOrEqual(text(result.uid).length);

      // The block that stays on screen is the outermost ancestor that hides
      // its children, found here from the render rule (a collapsed block
      // with children, valid tables excepted), top-down.
      const path = pathTo(tree, target);
      const byUid = new Map(nodes.map((n) => [n.uid, n]));
      const hider = path.slice(0, -1).find((uid) => {
        const n: BlockNode = byUid.get(uid)!;
        return n.collapsed && n.children.length > 0 && !isTable(n);
      });
      if (hider !== undefined) {
        tally.hidden += 1;
        expect(result).toEqual({ uid: hider, cursor: text(hider).length });
        return;
      }
      expect(result.uid).toBe(target);
      if (path.slice(0, -1).some((u) => isTable(byUid.get(u)!))) tally.tableCell += 1;
      const len = text(target).length;
      expect(insidePair(text(target), result.cursor)).toBe(false);
      if (cursor > len) {
        tally.past += 1;
        expect(result.cursor).toBe(len);
      } else if (insidePair(text(target), cursor)) {
        // A placed caret never splits a pair: it moves to the pair's start.
        tally.midPair += 1;
        expect(result).toEqual({ uid: target, cursor: cursor - 1 });
      } else {
        tally.kept += 1;
        expect(result).toBe(focus);
      }
    }), { numRuns: 500 });
    for (const [name, count] of Object.entries(tally)) {
      // midPair's floor is about half its lowest count over 26 runs (17);
      // the others sit well above 15, and 15 is under half of their lowest.
      expect(count, name).toBeGreaterThan(name === "midPair" ? 8 : 15);
    }
  });
});
