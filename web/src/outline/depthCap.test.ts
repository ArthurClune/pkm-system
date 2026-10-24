import { expect, it } from "vitest";
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import { block, canonicalTitleOf, orderIdxOf, uidOf } from "../test-helpers";
import { DEPTH_NOTICE, MAX_OUTLINE_DEPTH, findDepthViolation,
         subtreeHeight } from "./depthCap";

// Imported, not read with node:fs, as EditablePage.draftFlush.test.tsx does.
import fixture from "../../../shared/fixtures/outline_depth.json";

const PAGE = canonicalTitleOf("Deep");

/** A single chain `tuid-c1 > tuid-c2 > ... > tuid-c<n>`: block cN sits at
 * level N. */
function chain(n: number): BlockNode[] {
  let node = block(`tuid-c${n}`, `c${n}`);
  for (let level = n - 1; level >= 1; level--) {
    node = block(`tuid-c${level}`, `c${level}`, { children: [node] });
  }
  return [node];
}

const createAt = (level: number): BlockOp => ({
  op: "create", uid: uidOf(`tuid-c${level}`), page_title: PAGE,
  parent_uid: uidOf(`tuid-c${level - 1}`), order_idx: orderIdxOf(0),
  text: "",
});

const moveOf = (level: number): BlockOp => ({
  op: "move", uid: uidOf(`tuid-c${level}`),
  parent_uid: uidOf(`tuid-c${level - 1}`), order_idx: orderIdxOf(0),
});

it("the cap equals the server's, through the shared fixture", () => {
  expect(MAX_OUTLINE_DEPTH).toBe(fixture.max_outline_depth);
  expect(DEPTH_NOTICE).toBe("Blocks can't nest more than 100 levels deep.");
});

it("a create at level 100 passes and one at 101 is named", () => {
  expect(findDepthViolation(chain(100), [createAt(100)])).toBeNull();
  expect(findDepthViolation(chain(101), [createAt(101)]))
    .toBe(uidOf("tuid-c101"));
});

it("a move is judged by its subtree's deepest block, not its root", () => {
  // c50 lands at level 50; its subtree runs 51 levels further to c101
  expect(findDepthViolation(chain(101), [moveOf(50)]))
    .toBe(uidOf("tuid-c50"));
  // 50 levels further reaches c100 exactly
  expect(findDepthViolation(chain(100), [moveOf(50)])).toBeNull();
});

it("names the first op past the cap, in op order", () => {
  expect(findDepthViolation(chain(102), [moveOf(102), createAt(101)]))
    .toBe(uidOf("tuid-c102"));
});

it("an op whose block left the tree is not judged", () => {
  const gone: BlockOp = {
    op: "move", uid: uidOf("tuid-gone"), parent_uid: null,
    order_idx: orderIdxOf(0), page_title: canonicalTitleOf("Elsewhere"),
  };
  expect(findDepthViolation(chain(101), [gone])).toBeNull();
});

it("update_text and delete ops are never judged", () => {
  const ops: BlockOp[] = [
    { op: "update_text", uid: uidOf("tuid-c101"), text: "x" },
    { op: "delete", uid: uidOf("tuid-c101") },
  ];
  expect(findDepthViolation(chain(101), ops)).toBeNull();
});

it("a smaller max is honoured", () => {
  expect(findDepthViolation(chain(3), [createAt(3)], 2))
    .toBe(uidOf("tuid-c3"));
  expect(findDepthViolation(chain(3), [createAt(3)], 3)).toBeNull();
});

it("subtreeHeight counts levels below the node, a leaf being 0", () => {
  expect(subtreeHeight(block("tuid-leaf", "leaf"))).toBe(0);
  expect(subtreeHeight(chain(5)[0])).toBe(4);
  const uneven = block("tuid-r", "r", { children: [
    block("tuid-a", "a"),
    block("tuid-b", "b", { children: [block("tuid-b1", "b1")] }),
  ] });
  expect(subtreeHeight(uneven)).toBe(2);
});
