import { describe, it, expect } from "vitest";
import { block, uid } from "../test-helpers";
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

const NESTED = [
  block("r", "root", {
    order_idx: 0,
    children: [
      block("r0", "child", {
        order_idx: 0,
        children: [block("r00", "grand", { order_idx: 0 })],
      }),
    ],
  }),
  block("s", "sibling", { order_idx: 1 }),
];

describe("selectedUids", () => {
  it("returns the inclusive run in document order (anchor before head)", () => {
    expect(selectedUids(BLOCKS, { anchor: uid("a"), head: uid("c") })).toEqual(["a", "b", "c"]);
  });

  it("normalises a head-before-anchor selection to document order", () => {
    expect(selectedUids(BLOCKS, { anchor: uid("c"), head: uid("a") })).toEqual(["a", "b", "c"]);
  });

  it("a single-block selection is just that block", () => {
    expect(selectedUids(BLOCKS, { anchor: uid("b"), head: uid("b") })).toEqual(["b"]);
  });

  it("never includes a collapsed subtree's hidden children", () => {
    expect(selectedUids(BLOCKS, { anchor: uid("a"), head: uid("d") })).toEqual(["a", "b", "c", "d"]);
  });

  it("is empty when an end is not visible", () => {
    expect(selectedUids(BLOCKS, { anchor: uid("a"), head: uid("c1") })).toEqual([]);
  });
});

describe("extendSelection", () => {
  it("moves the head down one visible block, anchor fixed", () => {
    expect(extendSelection(BLOCKS, { anchor: uid("a"), head: uid("a") }, "down"))
      .toEqual({ anchor: "a", head: "b" });
  });

  it("moves the head up one visible block", () => {
    expect(extendSelection(BLOCKS, { anchor: uid("d"), head: uid("c") }, "up"))
      .toEqual({ anchor: "d", head: "b" });
  });

  it("skips a collapsed subtree's hidden children", () => {
    expect(extendSelection(BLOCKS, { anchor: uid("a"), head: uid("c") }, "down"))
      .toEqual({ anchor: "a", head: "d" });
  });

  it("clamps at the bottom edge", () => {
    expect(extendSelection(BLOCKS, { anchor: uid("a"), head: uid("d") }, "down"))
      .toEqual({ anchor: "a", head: "d" });
  });

  it("clamps at the top edge", () => {
    expect(extendSelection(BLOCKS, { anchor: uid("d"), head: uid("a") }, "up"))
      .toEqual({ anchor: "d", head: "a" });
  });
});

describe("selectionDragUids", () => {
  it("returns the selection's uids when the grabbed block is part of it", () => {
    expect(selectionDragUids(BLOCKS, { anchor: uid("a"), head: uid("b") }, uid("a")))
      .toEqual(["a", "b"]);
    expect(selectionDragUids(BLOCKS, { anchor: uid("a"), head: uid("b") }, uid("b")))
      .toEqual(["a", "b"]);
  });

  it("returns null when the grabbed block is outside the selection", () => {
    expect(selectionDragUids(BLOCKS, { anchor: uid("a"), head: uid("b") }, uid("d"))).toBeNull();
  });

  it("reduces a parent + selected descendant to the parent (root uids only)", () => {
    // expand c so its child c1 is visible and selectable
    const expanded = BLOCKS.map((b) =>
      b.uid === "c" ? { ...b, collapsed: false } : b);
    expect(selectionDragUids(expanded, { anchor: uid("c"), head: uid("d") }, uid("c")))
      .toEqual(["c", "d"]); // c1 folded into c's subtree
  });
});

describe("needsDeleteConfirmation", () => {
  it("does not require confirmation for 20 or fewer blocks", () => {
    expect(needsDeleteConfirmation(0)).toBe(false);
    expect(needsDeleteConfirmation(1)).toBe(false);
    expect(needsDeleteConfirmation(6)).toBe(false);
    expect(needsDeleteConfirmation(20)).toBe(false);
  });

  it("requires confirmation for more than 20 blocks", () => {
    expect(needsDeleteConfirmation(21)).toBe(true);
    expect(needsDeleteConfirmation(200)).toBe(true);
  });
});

describe("selectionText", () => {
  it("joins the selected blocks' text with newlines in document order", () => {
    expect(selectionText(BLOCKS, { anchor: uid("a"), head: uid("c") })).toBe("one\ntwo\nthree");
  });

  it("orders by the document even when head precedes anchor", () => {
    expect(selectionText(BLOCKS, { anchor: uid("c"), head: uid("a") })).toBe("one\ntwo\nthree");
  });

  it("indents by depth relative to the shallowest selected block", () => {
    expect(selectionText(NESTED, { anchor: uid("r"), head: uid("s") }))
      .toBe("root\n\tchild\n\t\tgrand\nsibling");
    // selection entirely below the top level re-bases at zero tabs
    expect(selectionText(NESTED, { anchor: uid("r0"), head: uid("r00") }))
      .toBe("child\n\tgrand");
  });
});
