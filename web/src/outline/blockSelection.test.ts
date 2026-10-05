import { describe, it, expect } from "vitest";
import { block, ord, uid } from "../test-helpers";
import { extendSelection, needsDeleteConfirmation, selectedUids,
         selectionDragUids, selectionText, startSelection } from "./blockSelection";

// a: "one", b: "two", c(collapsed): "three" with hidden child c1, d: "four"
const BLOCKS = [
  block("a", "one", { order_idx: ord(0) }),
  block("b", "two", { order_idx: ord(1) }),
  block("c", "three", {
    order_idx: ord(2), collapsed: true,
    children: [block("c1", "hidden", { order_idx: ord(0) })],
  }),
  block("d", "four", { order_idx: ord(3) }),
];

const NESTED = [
  block("r", "root", {
    order_idx: ord(0),
    children: [
      block("r0", "child", {
        order_idx: ord(0),
        children: [block("r00", "grand", { order_idx: ord(0) })],
      }),
    ],
  }),
  block("s", "sibling", { order_idx: ord(1) }),
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

// above, a {{table}} of two rows (r1a>r1b, r2a>r2b), below
const tableTree = (collapsed: boolean) => [
  block("above", "above", { order_idx: ord(0) }),
  block("t", "{{table}}", {
    order_idx: ord(1), collapsed,
    children: [
      block("r1a", "r1a", { order_idx: ord(0), children: [block("r1b", "r1b")] }),
      block("r2a", "r2a", { order_idx: ord(1), children: [block("r2b", "r2b")] }),
    ],
  }),
  block("below", "below", { order_idx: ord(2) }),
];

describe.each([true, false])("a Roam table in a selection (collapsed=%s)", (collapsed) => {
  it("is one row: extending from above goes table, then below", () => {
    const blocks = tableTree(collapsed);
    const s1 = extendSelection(blocks, { anchor: uid("above"), head: uid("above") }, "down");
    expect(s1.head).toBe("t");
    const s2 = extendSelection(blocks, s1, "down");
    expect(s2.head).toBe("below");
    expect(selectedUids(blocks, s2)).toEqual(["above", "t", "below"]);
  });

  it("copies the table's cells, indented, between the neighbouring blocks", () => {
    const blocks = tableTree(collapsed);
    expect(selectionText(blocks, { anchor: uid("above"), head: uid("below") }))
      .toBe("above\n{{table}}\n\tr1a\n\t\tr1b\n\tr2a\n\t\tr2b\nbelow");
  });

  it("copies a table nested under a parent relative to the shallowest block", () => {
    const blocks = [block("p", "p", { children: tableTree(collapsed) })];
    expect(selectionText(blocks, { anchor: uid("t"), head: uid("below") }))
      .toBe("{{table}}\n\tr1a\n\t\tr1b\n\tr2a\n\t\tr2b\nbelow");
  });
});

describe("startSelection", () => {
  it("from a cell anchors on the table and heads on the block after it", () => {
    const blocks = tableTree(true);
    expect(startSelection(blocks, uid("r1b"), "down"))
      .toEqual({ anchor: "t", head: "below" });
    expect(startSelection(blocks, uid("r2a"), "up"))
      .toEqual({ anchor: "t", head: "above" });
  });

  it("with no direction selects just the table", () => {
    expect(startSelection(tableTree(false), uid("r1b"), null))
      .toEqual({ anchor: "t", head: "t" });
  });

  it("lifts to the outermost table when tables nest", () => {
    const inner = block("it", "{{table}}", { children: [block("ic", "ic")] });
    const blocks = [
      block("t", "{{table}}", { children: [block("c", "c", { children: [inner] })] }),
    ];
    // the outer table is invalid only if a cell has two children; here it is valid
    expect(startSelection(blocks, uid("ic"), null)).toEqual({ anchor: "t", head: "t" });
  });

  it("from an ordinary block matches plain neighbour stepping", () => {
    expect(startSelection(BLOCKS, uid("b"), "down")).toEqual({ anchor: "b", head: "c" });
    expect(startSelection(BLOCKS, uid("b"), "up")).toEqual({ anchor: "b", head: "a" });
    expect(startSelection(BLOCKS, uid("a"), "up")).toEqual({ anchor: "a", head: "a" });
    expect(startSelection(BLOCKS, uid("d"), "down")).toEqual({ anchor: "d", head: "d" });
    expect(startSelection(BLOCKS, uid("b"), null)).toEqual({ anchor: "b", head: "b" });
  });

  it("an ordinary block with children keeps them out of a copied selection when collapsed", () => {
    expect(selectionText(BLOCKS, { anchor: uid("b"), head: uid("d") }))
      .toBe("two\nthree\nfour");
  });
});
