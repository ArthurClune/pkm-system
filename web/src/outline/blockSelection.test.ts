import { describe, it, expect } from "vitest";
import { block, orderIdxOf, uidOf } from "../test-helpers";
import { extendSelection, needsDeleteConfirmation, selectedUids,
         selectionDragUids, selectionText, startSelection } from "./blockSelection";

// a: "one", b: "two", c(collapsed): "three" with hidden child c1, d: "four"
const BLOCKS = [
  block("tuid-a", "one", { order_idx: orderIdxOf(0) }),
  block("tuid-b", "two", { order_idx: orderIdxOf(1) }),
  block("tuid-c", "three", {
    order_idx: orderIdxOf(2), collapsed: true,
    children: [block("tuid-c1", "hidden", { order_idx: orderIdxOf(0) })],
  }),
  block("tuid-d", "four", { order_idx: orderIdxOf(3) }),
];

const NESTED = [
  block("tuid-r", "root", {
    order_idx: orderIdxOf(0),
    children: [
      block("tuid-r0", "child", {
        order_idx: orderIdxOf(0),
        children: [block("tuid-r00", "grand", { order_idx: orderIdxOf(0) })],
      }),
    ],
  }),
  block("tuid-s", "sibling", { order_idx: orderIdxOf(1) }),
];

describe("selectedUids", () => {
  it("returns the inclusive run in document order (anchor before head)", () => {
    expect(selectedUids(BLOCKS, { anchor: uidOf("tuid-a"), head: uidOf("tuid-c") }))
      .toEqual(["tuid-a", "tuid-b", "tuid-c"]);
  });

  it("normalises a head-before-anchor selection to document order", () => {
    expect(selectedUids(BLOCKS, { anchor: uidOf("tuid-c"), head: uidOf("tuid-a") }))
      .toEqual(["tuid-a", "tuid-b", "tuid-c"]);
  });

  it("a single-block selection is just that block", () => {
    expect(selectedUids(BLOCKS, { anchor: uidOf("tuid-b"), head: uidOf("tuid-b") })).toEqual(["tuid-b"]);
  });

  it("never includes a collapsed subtree's hidden children", () => {
    expect(selectedUids(BLOCKS, { anchor: uidOf("tuid-a"), head: uidOf("tuid-d") }))
      .toEqual(["tuid-a", "tuid-b", "tuid-c", "tuid-d"]);
  });

  it("is empty when an end is not visible", () => {
    expect(selectedUids(BLOCKS, { anchor: uidOf("tuid-a"), head: uidOf("tuid-c1") })).toEqual([]);
  });
});

describe("extendSelection", () => {
  it("moves the head down one visible block, anchor fixed", () => {
    expect(extendSelection(BLOCKS, { anchor: uidOf("tuid-a"), head: uidOf("tuid-a") }, "down"))
      .toEqual({ anchor: "tuid-a", head: "tuid-b" });
  });

  it("moves the head up one visible block", () => {
    expect(extendSelection(BLOCKS, { anchor: uidOf("tuid-d"), head: uidOf("tuid-c") }, "up"))
      .toEqual({ anchor: "tuid-d", head: "tuid-b" });
  });

  it("skips a collapsed subtree's hidden children", () => {
    expect(extendSelection(BLOCKS, { anchor: uidOf("tuid-a"), head: uidOf("tuid-c") }, "down"))
      .toEqual({ anchor: "tuid-a", head: "tuid-d" });
  });

  it("clamps at the bottom edge", () => {
    expect(extendSelection(BLOCKS, { anchor: uidOf("tuid-a"), head: uidOf("tuid-d") }, "down"))
      .toEqual({ anchor: "tuid-a", head: "tuid-d" });
  });

  it("clamps at the top edge", () => {
    expect(extendSelection(BLOCKS, { anchor: uidOf("tuid-d"), head: uidOf("tuid-a") }, "up"))
      .toEqual({ anchor: "tuid-d", head: "tuid-a" });
  });
});

describe("selectionDragUids", () => {
  it("returns the selection's uids when the grabbed block is part of it", () => {
    expect(selectionDragUids(BLOCKS, { anchor: uidOf("tuid-a"), head: uidOf("tuid-b") }, uidOf("tuid-a")))
      .toEqual(["tuid-a", "tuid-b"]);
    expect(selectionDragUids(BLOCKS, { anchor: uidOf("tuid-a"), head: uidOf("tuid-b") }, uidOf("tuid-b")))
      .toEqual(["tuid-a", "tuid-b"]);
  });

  it("returns null when the grabbed block is outside the selection", () => {
    expect(selectionDragUids(BLOCKS, { anchor: uidOf("tuid-a"), head: uidOf("tuid-b") }, uidOf("tuid-d"))).toBeNull();
  });

  it("reduces a parent + selected descendant to the parent (root uids only)", () => {
    // expand c so its child c1 is visible and selectable
    const expanded = BLOCKS.map((b) =>
      b.uid === "tuid-c" ? { ...b, collapsed: false } : b);
    expect(selectionDragUids(expanded, { anchor: uidOf("tuid-c"), head: uidOf("tuid-d") }, uidOf("tuid-c")))
      .toEqual(["tuid-c", "tuid-d"]); // c1 folded into c's subtree
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
    expect(selectionText(BLOCKS, { anchor: uidOf("tuid-a"), head: uidOf("tuid-c") })).toBe("one\ntwo\nthree");
  });

  it("orders by the document even when head precedes anchor", () => {
    expect(selectionText(BLOCKS, { anchor: uidOf("tuid-c"), head: uidOf("tuid-a") })).toBe("one\ntwo\nthree");
  });

  it("indents by depth relative to the shallowest selected block", () => {
    expect(selectionText(NESTED, { anchor: uidOf("tuid-r"), head: uidOf("tuid-s") }))
      .toBe("root\n\tchild\n\t\tgrand\nsibling");
    // selection entirely below the top level re-bases at zero tabs
    expect(selectionText(NESTED, { anchor: uidOf("tuid-r0"), head: uidOf("tuid-r00") }))
      .toBe("child\n\tgrand");
  });
});

// above, a {{table}} of two rows (r1a>r1b, r2a>r2b), below
const tableTree = (collapsed: boolean) => [
  block("tuid-above", "above", { order_idx: orderIdxOf(0) }),
  block("tuid-t", "{{table}}", {
    order_idx: orderIdxOf(1), collapsed,
    children: [
      block("tuid-r1a", "r1a", { order_idx: orderIdxOf(0), children: [block("tuid-r1b", "r1b")] }),
      block("tuid-r2a", "r2a", { order_idx: orderIdxOf(1), children: [block("tuid-r2b", "r2b")] }),
    ],
  }),
  block("tuid-below", "below", { order_idx: orderIdxOf(2) }),
];

describe.each([true, false])("a Roam table in a selection (collapsed=%s)", (collapsed) => {
  it("is one row: extending from above goes table, then below", () => {
    const blocks = tableTree(collapsed);
    const s1 = extendSelection(blocks, { anchor: uidOf("tuid-above"), head: uidOf("tuid-above") }, "down");
    expect(s1.head).toBe("tuid-t");
    const s2 = extendSelection(blocks, s1, "down");
    expect(s2.head).toBe("tuid-below");
    expect(selectedUids(blocks, s2)).toEqual(["tuid-above", "tuid-t", "tuid-below"]);
  });

  it("copies the table's cells, indented, between the neighbouring blocks", () => {
    const blocks = tableTree(collapsed);
    expect(selectionText(blocks, { anchor: uidOf("tuid-above"), head: uidOf("tuid-below") }))
      .toBe("above\n{{table}}\n\tr1a\n\t\tr1b\n\tr2a\n\t\tr2b\nbelow");
  });

  it("copies a table nested under a parent relative to the shallowest block", () => {
    const blocks = [block("tuid-p", "p", { children: tableTree(collapsed) })];
    expect(selectionText(blocks, { anchor: uidOf("tuid-t"), head: uidOf("tuid-below") }))
      .toBe("{{table}}\n\tr1a\n\t\tr1b\n\tr2a\n\t\tr2b\nbelow");
  });
});

describe("startSelection", () => {
  it("from a cell anchors on the table and heads on the block after it", () => {
    const blocks = tableTree(true);
    expect(startSelection(blocks, uidOf("tuid-r1b"), "down"))
      .toEqual({ anchor: "tuid-t", head: "tuid-below" });
    expect(startSelection(blocks, uidOf("tuid-r2a"), "up"))
      .toEqual({ anchor: "tuid-t", head: "tuid-above" });
  });

  it("with no direction selects just the table", () => {
    expect(startSelection(tableTree(false), uidOf("tuid-r1b"), null))
      .toEqual({ anchor: "tuid-t", head: "tuid-t" });
  });

  it("lifts to the outermost table when tables nest", () => {
    const inner = block("tuid-it", "{{table}}", { children: [block("tuid-ic", "ic")] });
    const blocks = [
      block("tuid-t", "{{table}}", { children: [block("tuid-c", "c", { children: [inner] })] }),
    ];
    // the outer table is invalid only if a cell has two children; here it is
    // valid
    expect(startSelection(blocks, uidOf("tuid-ic"), null)).toEqual({ anchor: "tuid-t", head: "tuid-t" });
  });

  it("from an ordinary block matches plain neighbour stepping", () => {
    expect(startSelection(BLOCKS, uidOf("tuid-b"), "down")).toEqual({ anchor: "tuid-b", head: "tuid-c" });
    expect(startSelection(BLOCKS, uidOf("tuid-b"), "up")).toEqual({ anchor: "tuid-b", head: "tuid-a" });
    expect(startSelection(BLOCKS, uidOf("tuid-a"), "up")).toEqual({ anchor: "tuid-a", head: "tuid-a" });
    expect(startSelection(BLOCKS, uidOf("tuid-d"), "down")).toEqual({ anchor: "tuid-d", head: "tuid-d" });
    expect(startSelection(BLOCKS, uidOf("tuid-b"), null)).toEqual({ anchor: "tuid-b", head: "tuid-b" });
  });

  it("an ordinary block with children keeps them out of a copied selection when collapsed", () => {
    expect(selectionText(BLOCKS, { anchor: uidOf("tuid-b"), head: uidOf("tuid-d") }))
      .toBe("two\nthree\nfour");
  });
});
