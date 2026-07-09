import { expect, it } from "vitest";
import { block } from "../test-helpers";
import type { BlockNode } from "../api/payloads";
import { allowedDepths, depthFromX, dropRows, resolveDrop,
         INDENT_PX } from "./dnd";

// Page "P":  a(0) [ b(0) [ c(0) ] ]  d(1, collapsed) [ e(0) ]  f(2)
function page(): BlockNode[] {
  return [
    { ...block("a", "A", { order_idx: 0 }), children: [
      { ...block("b", "B", { order_idx: 0 }), children: [
        block("c", "C", { order_idx: 0 })] }] },
    { ...block("d", "D", { order_idx: 1, collapsed: true }), children: [
      block("e", "E", { order_idx: 0 })] },
    block("f", "F", { order_idx: 2 }),
  ];
}
const OTHER: DragSource = { uid: "zz", pageTitle: "Elsewhere" };
type DragSource = { uid: string; pageTitle: string };

it("dropRows hides collapsed children and excludes the dragged subtree", () => {
  expect(dropRows(page(), OTHER, "P").map((r) => r.uid))
    .toEqual(["a", "b", "c", "d", "f"]); // e hidden under collapsed d
  expect(dropRows(page(), { uid: "b", pageTitle: "P" }, "P").map((r) => r.uid))
    .toEqual(["a", "d", "f"]);           // b and c lifted out
});

it("allowedDepths spans below-depth..above-depth+1, capped by collapse", () => {
  const rows = dropRows(page(), OTHER, "P");
  expect(allowedDepths(rows, 0)).toEqual([0]);          // top: only depth 0
  expect(allowedDepths(rows, 3)).toEqual([0, 1, 2, 3]); // after c(d2): up to child-of-c
  expect(allowedDepths(rows, 4)).toEqual([0]);          // after collapsed d: NO child depth
  expect(allowedDepths(rows, 5)).toEqual([0, 1]);       // end: top level or child of f
  expect(allowedDepths([], 0)).toEqual([0]);            // empty outline
});

it("depthFromX rounds by indent and clamps to the allowed range", () => {
  expect(depthFromX([0, 1, 2], 0)).toBe(0);
  expect(depthFromX([0, 1, 2], 1.4 * INDENT_PX)).toBe(1);
  expect(depthFromX([0, 1, 2], 99 * INDENT_PX)).toBe(2);
  expect(depthFromX([1, 2], 0)).toBe(1);
});

it("resolveDrop picks parent and order_idx from the chosen depth", () => {
  // boundary 3 = after c; depth 1 → child of a, after b → order_idx 1
  expect(resolveDrop(page(), "P", OTHER, 3, 1))
    .toEqual({ parent_uid: "a", order_idx: 1, page_title: "P" });
  // boundary 3, depth 3 → first child of c
  expect(resolveDrop(page(), "P", OTHER, 3, 3))
    .toEqual({ parent_uid: "c", order_idx: 0, page_title: "P" });
  // boundary 1 = after a (b is a's child at depth 1); depth 0 → top level.
  // First row at/after boundary with parent null (depth 0) is d with order_idx 1
  // → insert before d at top level
  expect(resolveDrop(page(), "P", OTHER, 1, 0))
    .toEqual({ parent_uid: null, order_idx: 1, page_title: "P" });
  // boundary 5 = end of outline, after f; depth 1 → child of f (childless) → first child
  expect(resolveDrop(page(), "P", OTHER, 5, 1))
    .toEqual({ parent_uid: "f", order_idx: 0, page_title: "P" });
});

it("resolveDrop returns null for a same-position drop", () => {
  // dragging f, dropping at the very end at depth 0 = where it already is
  const drag = { uid: "f", pageTitle: "P" };
  const rows = dropRows(page(), drag, "P");
  expect(resolveDrop(page(), "P", drag, rows.length, 0)).toBeNull();
  // and dropping right before its own old slot is also a no-op
  expect(resolveDrop(page(), "P", drag, 4, 0)).toBeNull();
});

it("resolveDrop from another page never returns null (content must move)", () => {
  const t = resolveDrop(page(), "P", OTHER, 5, 0);
  expect(t).toEqual({ parent_uid: null, order_idx: 3, page_title: "P" });
});
