import { describe, it, expect } from "vitest";
import { block } from "../test-helpers";
import { extendSelection, needsDeleteConfirmation, selectedUids,
         selectionDragUids, selectionText } from "./blockSelection";

// a: "one", b: "two", c(collapsed): "three" with hidden child c1, d: "four"
const BLOCKS = [
  block("a", "one", { order_idx: 0 }),
  block("b", "two", { order_idx: 1 }),
  block("c", "three", {
    order_idx: 2, collapsed: true,
    children: [block("c1", "hidden", { order_idx: 0 })],
  }),
  block("d", "four", { order_idx: 3 }),
];

describe("selectedUids", () => {
  it("returns the inclusive run in document order (anchor before head)", () => {
    expect(selectedUids(BLOCKS, { anchor: "a", head: "c" })).toEqual(["a", "b", "c"]);
  });

  it("normalises a head-before-anchor selection to document order", () => {
    expect(selectedUids(BLOCKS, { anchor: "c", head: "a" })).toEqual(["a", "b", "c"]);
  });

  it("a single-block selection is just that block", () => {
    expect(selectedUids(BLOCKS, { anchor: "b", head: "b" })).toEqual(["b"]);
  });

  it("never includes a collapsed subtree's hidden children", () => {
    expect(selectedUids(BLOCKS, { anchor: "a", head: "d" })).toEqual(["a", "b", "c", "d"]);
  });

  it("is empty when an end is not visible", () => {
    expect(selectedUids(BLOCKS, { anchor: "a", head: "c1" })).toEqual([]);
  });
});

describe("extendSelection", () => {
  it("moves the head down one visible block, anchor fixed", () => {
    expect(extendSelection(BLOCKS, { anchor: "a", head: "a" }, "down"))
      .toEqual({ anchor: "a", head: "b" });
  });

  it("moves the head up one visible block", () => {
    expect(extendSelection(BLOCKS, { anchor: "d", head: "c" }, "up"))
      .toEqual({ anchor: "d", head: "b" });
  });

  it("skips a collapsed subtree's hidden children", () => {
    expect(extendSelection(BLOCKS, { anchor: "a", head: "c" }, "down"))
      .toEqual({ anchor: "a", head: "d" });
  });

  it("clamps at the bottom edge", () => {
    expect(extendSelection(BLOCKS, { anchor: "a", head: "d" }, "down"))
      .toEqual({ anchor: "a", head: "d" });
  });

  it("clamps at the top edge", () => {
    expect(extendSelection(BLOCKS, { anchor: "d", head: "a" }, "up"))
      .toEqual({ anchor: "d", head: "a" });
  });
});

describe("selectionDragUids (pkm-q89w drag)", () => {
  it("returns the selection's uids when the grabbed block is part of it", () => {
    expect(selectionDragUids(BLOCKS, { anchor: "a", head: "b" }, "a"))
      .toEqual(["a", "b"]);
    expect(selectionDragUids(BLOCKS, { anchor: "a", head: "b" }, "b"))
      .toEqual(["a", "b"]);
  });

  it("returns null when the grabbed block is outside the selection", () => {
    expect(selectionDragUids(BLOCKS, { anchor: "a", head: "b" }, "d")).toBeNull();
  });

  it("reduces a parent + selected descendant to the parent (root uids only)", () => {
    // expand c so its child c1 is visible and selectable
    const expanded = BLOCKS.map((b) =>
      b.uid === "c" ? { ...b, collapsed: false } : b);
    expect(selectionDragUids(expanded, { anchor: "c", head: "d" }, "c"))
      .toEqual(["c", "d"]); // c1 folded into c's subtree
  });
});

describe("needsDeleteConfirmation (pkm-q89w)", () => {
  it("does not require confirmation for 5 or fewer blocks", () => {
    expect(needsDeleteConfirmation(0)).toBe(false);
    expect(needsDeleteConfirmation(1)).toBe(false);
    expect(needsDeleteConfirmation(5)).toBe(false);
  });

  it("requires confirmation for more than 5 blocks", () => {
    expect(needsDeleteConfirmation(6)).toBe(true);
    expect(needsDeleteConfirmation(20)).toBe(true);
  });
});

describe("selectionText", () => {
  it("joins the selected blocks' text with newlines in document order", () => {
    expect(selectionText(BLOCKS, { anchor: "a", head: "c" })).toBe("one\ntwo\nthree");
  });

  it("orders by the document even when head precedes anchor", () => {
    expect(selectionText(BLOCKS, { anchor: "c", head: "a" })).toBe("one\ntwo\nthree");
  });
});
