import { describe, expect, test } from "vitest";
import { block, orderIdxOf, canonicalTitleOf, typeProbe, uidOf } from "../test-helpers";
import { findNode } from "./tree";
import { backspaceAtStart, clampCaret, deleteSelection, indentBlock,
         indentSelection, moveBlockDown, moveBlocksTo, moveBlockUp,
         moveSelectionDown, moveSelectionUp, moveSubtreeDown, moveSubtreeUp,
         outdentBlock, outdentSelection, revealBlock, setCollapsed,
         setHeading, setViewType, splitBlock } from "./edits";

const someUid = uidOf("abcdef");

describe("clampCaret", () => {
  test("keeps the offset when it fits the new length", () => {
    expect(clampCaret(5, 10)).toBe(5);
  });

  test("clamps to the new length when the offset no longer fits", () => {
    expect(clampCaret(15, 2)).toBe(2);
  });

  test("never goes negative", () => {
    expect(clampCaret(-3, 10)).toBe(0);
  });
});

const P = canonicalTitleOf("Page");
const tree = () => [
  block("tuid-a", "alpha", { order_idx: orderIdxOf(0) }),
  block("tuid-b", "beta", {
    order_idx: orderIdxOf(5),
    children: [
      block("tuid-b1", "b-one", { order_idx: orderIdxOf(0) }),
      block("tuid-b2", "b-two", { order_idx: orderIdxOf(3) }),
    ],
  }),
  block("tuid-c", "gamma", { order_idx: orderIdxOf(7) }),
];

const adoptionTree = () => [
  block("tuid-p", "parent", {
    order_idx: orderIdxOf(0),
    children: [
      block("tuid-u", "u-block", {
        order_idx: orderIdxOf(0),
        children: [block("tuid-u1", "u child", { order_idx: orderIdxOf(4) })],
      }),
      block("tuid-s1", "sib one", { order_idx: orderIdxOf(1) }),
      block("tuid-s2", "sib two", { order_idx: orderIdxOf(2) }),
    ],
  }),
  block("tuid-z", "zed", { order_idx: orderIdxOf(9) }),
];

describe("splitBlock", () => {
  test("mid-text: keeps head in place, tail becomes the next sibling, focus on new", () => {
    const r = splitBlock(tree(), P, uidOf("tuid-a"), 2, uidOf("new111"));
    expect(r.ops).toEqual([
      { op: "update_text", uid: "tuid-a", text: "al" },
      { op: "create", uid: "new111", page_title: P, parent_uid: null,
        order_idx: 5, text: "pha" }, // before b (order 5), server shifts b,c
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-a", "new111", "tuid-b", "tuid-c"]);
    expect(r.focus).toEqual({ uid: "new111", cursor: 0 });
  });

  test("at end of a childless block: plain empty sibling, no update_text", () => {
    const r = splitBlock(tree(), P, uidOf("tuid-c"), 5, uidOf("new111"));
    expect(r.ops).toEqual([
      { op: "create", uid: "new111", page_title: P, parent_uid: null,
        order_idx: 8, text: "" },
    ]);
    expect(r.focus).toEqual({ uid: "new111", cursor: 0 });
  });

  test("at cursor 0 with text: empty block inserted ABOVE, uid keeps its text", () => {
    const r = splitBlock(tree(), P, uidOf("tuid-a"), 0, uidOf("new111"));
    expect(r.ops).toEqual([
      { op: "create", uid: "new111", page_title: P, parent_uid: null,
        order_idx: 0, text: "" },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["new111", "tuid-a", "tuid-b", "tuid-c"]);
    expect(r.focus).toEqual({ uid: "tuid-a", cursor: 0 });
  });

  test("on an expanded block with children: new block becomes first child", () => {
    const r = splitBlock(tree(), P, uidOf("tuid-b"), 4, uidOf("new111"));
    expect(r.ops).toEqual([
      { op: "create", uid: "new111", page_title: P, parent_uid: "tuid-b",
        order_idx: 0, text: "" },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["new111", "tuid-b1", "tuid-b2"]);
  });

  test("unknown uid is a no-op", () => {
    const r = splitBlock(tree(), P, uidOf("tuid-zz"), 0, uidOf("new111"));
    expect(r.ops).toEqual([]);
  });
});

// pageTitle and uid can't be swapped, and a raw string can't stand in for
// the page's title.
typeProbe(() => {
  // @ts-expect-error (title, uid) swapped
  indentBlock(tree(), someUid, "Page");
  // @ts-expect-error a raw string is not a CanonicalTitle
  indentBlock(tree(), "Page", someUid);
});

describe("indent / outdent", () => {
  test("indent moves under previous sibling, after its last child", () => {
    const r = indentBlock(tree(), P, uidOf("tuid-c"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-c", parent_uid: "tuid-b", order_idx: 4 }, // b2 is 3
    ]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["tuid-b1", "tuid-b2", "tuid-c"]);
  });

  test("indent expands a collapsed new parent first", () => {
    const t = tree();
    findNode(t, uidOf("tuid-b"))!.collapsed = true;
    const r = indentBlock(t, P, uidOf("tuid-c"));
    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "tuid-b", collapsed: false },
      { op: "move", uid: "tuid-c", parent_uid: "tuid-b", order_idx: 4 },
    ]);
  });

  test("first sibling can't indent", () => {
    expect(indentBlock(tree(), P, uidOf("tuid-a")).ops).toEqual([]);
    expect(indentBlock(tree(), P, uidOf("tuid-b1")).ops).toEqual([]);
  });

  test("outdent lands after its old parent and adopts trailing siblings", () => {
    const r = outdentBlock(tree(), P, uidOf("tuid-b1"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b1", parent_uid: null, order_idx: 7 }, // before c
      { op: "move", uid: "tuid-b2", parent_uid: "tuid-b1", order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-a", "tuid-b", "tuid-b1", "tuid-c"]);
    expect(findNode(r.blocks, uidOf("tuid-b1"))!.children.map((n) => n.uid))
      .toEqual(["tuid-b2"]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children).toEqual([]);
  });

  test("outdenting the last child emits no adoption ops", () => {
    const r = outdentBlock(tree(), P, uidOf("tuid-b2"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b2", parent_uid: null, order_idx: 7 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-a", "tuid-b", "tuid-b2", "tuid-c"]);
  });

  test("adopted siblings append after the block's existing children", () => {
    const r = outdentBlock(adoptionTree(), P, uidOf("tuid-u"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-u", parent_uid: null, order_idx: 9 }, // before z
      { op: "move", uid: "tuid-s1", parent_uid: "tuid-u", order_idx: 5 }, // u1 is 4
      { op: "move", uid: "tuid-s2", parent_uid: "tuid-u", order_idx: 6 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-p", "tuid-u", "tuid-z"]);
    expect(findNode(r.blocks, uidOf("tuid-u"))!.children.map((n) => n.uid))
      .toEqual(["tuid-u1", "tuid-s1", "tuid-s2"]);
    expect(findNode(r.blocks, uidOf("tuid-p"))!.children).toEqual([]);
  });

  test("a collapsed block expands when it adopts trailing siblings", () => {
    const t = adoptionTree();
    findNode(t, uidOf("tuid-u"))!.collapsed = true;
    const r = outdentBlock(t, P, uidOf("tuid-u"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-u", parent_uid: null, order_idx: 9 },
      { op: "set_collapsed", uid: "tuid-u", collapsed: false },
      { op: "move", uid: "tuid-s1", parent_uid: "tuid-u", order_idx: 5 },
      { op: "move", uid: "tuid-s2", parent_uid: "tuid-u", order_idx: 6 },
    ]);
  });

  test("no expand op when a collapsed block adopts nothing", () => {
    const t = tree();
    findNode(t, uidOf("tuid-b2"))!.collapsed = true;
    const r = outdentBlock(t, P, uidOf("tuid-b2"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b2", parent_uid: null, order_idx: 7 },
    ]);
  });

  test("top-level blocks can't outdent", () => {
    expect(outdentBlock(tree(), P, uidOf("tuid-a")).ops).toEqual([]);
  });
});

const selectionTree = () => [
  block("tuid-a", "A", {
    order_idx: orderIdxOf(0),
    children: [
      block("tuid-a0", "A zero", { order_idx: orderIdxOf(0) }),
      block("tuid-a1", "A one", {
        order_idx: orderIdxOf(1),
        children: [block("tuid-a1x", "A one child", { order_idx: orderIdxOf(0) })],
      }),
    ],
  }),
  block("tuid-b", "B", {
    order_idx: orderIdxOf(1),
    children: [block("tuid-b1", "B child", { order_idx: orderIdxOf(0) })],
  }),
  block("tuid-c", "C", { order_idx: orderIdxOf(2) }),
];

const mixedOutdentTree = () => [
  block("tuid-root", "Root", {
    order_idx: orderIdxOf(0),
    children: [
      block("tuid-p", "P", {
        order_idx: orderIdxOf(0),
        children: [
          block("tuid-p0", "P zero", { order_idx: orderIdxOf(0) }),
          block("tuid-x", "X", { order_idx: orderIdxOf(1) }),
        ],
      }),
      block("tuid-q", "Q", {
        order_idx: orderIdxOf(1),
        children: [block("tuid-q1", "Q child", { order_idx: orderIdxOf(0) })],
      }),
    ],
  }),
  block("tuid-z", "Z", { order_idx: orderIdxOf(1) }),
];

const gapTree = () => [
  block("tuid-top", "top parent", {
    order_idx: orderIdxOf(0),
    children: [
      block("tuid-s1", "one", { order_idx: orderIdxOf(0) }),
      block("tuid-s2", "two", { order_idx: orderIdxOf(1) }),
      block("tuid-s3", "three", { order_idx: orderIdxOf(2) }),
      block("tuid-s4", "four", { order_idx: orderIdxOf(3) }),
      block("tuid-s5", "five", { order_idx: orderIdxOf(4) }),
    ],
  }),
];

describe("indentSelection / outdentSelection", () => {
  test("indents one sibling run under one parent without staircasing", () => {
    const r = indentSelection(selectionTree(), P, [uidOf("tuid-b"), uidOf("tuid-b1"), uidOf("tuid-c")]);

    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b", parent_uid: "tuid-a", order_idx: 2 },
      { op: "move", uid: "tuid-c", parent_uid: "tuid-a", order_idx: 3 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-a"]);
    expect(findNode(r.blocks, uidOf("tuid-a"))!.children.map((n) => n.uid))
      .toEqual(["tuid-a0", "tuid-a1", "tuid-b", "tuid-c"]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["tuid-b1"]);
  });

  test("indents mixed-level roots from original destinations by one level", () => {
    const r = indentSelection(selectionTree(), P, [uidOf("tuid-a1"), uidOf("tuid-a1x"), uidOf("tuid-b"),
      uidOf("tuid-b1")]);

    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-a1", parent_uid: "tuid-a0", order_idx: 0 },
      { op: "move", uid: "tuid-b", parent_uid: "tuid-a", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-a0"))!.children.map((n) => n.uid))
      .toEqual(["tuid-a1"]);
    expect(findNode(r.blocks, uidOf("tuid-a1"))!.children.map((n) => n.uid))
      .toEqual(["tuid-a1x"]);
    expect(findNode(r.blocks, uidOf("tuid-a"))!.children.map((n) => n.uid))
      .toEqual(["tuid-a0", "tuid-b"]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["tuid-b1"]);
  });

  test("expands a collapsed destination once before moving its run", () => {
    const t = selectionTree();
    findNode(t, uidOf("tuid-a"))!.collapsed = true;

    const r = indentSelection(t, P, [uidOf("tuid-b"), uidOf("tuid-b1"), uidOf("tuid-c")]);

    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "tuid-a", collapsed: false },
      { op: "move", uid: "tuid-b", parent_uid: "tuid-a", order_idx: 2 },
      { op: "move", uid: "tuid-c", parent_uid: "tuid-a", order_idx: 3 },
    ]);
  });

  test("one first-sibling run aborts every indent run", () => {
    const t = selectionTree();
    const r = indentSelection(
      t, P, [uidOf("tuid-a0"), uidOf("tuid-a1"), uidOf("tuid-a1x"), uidOf("tuid-b"), uidOf("tuid-b1")],
    );

    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });

  test("outdents one sibling run consecutively after its former parent", () => {
    const r = outdentSelection(selectionTree(), P, [uidOf("tuid-a0"), uidOf("tuid-a1"), uidOf("tuid-a1x")]);

    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-a0", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "tuid-a1", parent_uid: null, order_idx: 2 },
    ]);
    expect(r.blocks.map((n) => n.uid))
      .toEqual(["tuid-a", "tuid-a0", "tuid-a1", "tuid-b", "tuid-c"]);
    expect(findNode(r.blocks, uidOf("tuid-a1"))!.children.map((n) => n.uid))
      .toEqual(["tuid-a1x"]);
  });

  test("outdents mixed-level roots once while preserving their subtrees", () => {
    const r = outdentSelection(
      mixedOutdentTree(), P, [uidOf("tuid-x"), uidOf("tuid-q"), uidOf("tuid-q1")],
    );

    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-x", parent_uid: "tuid-root", order_idx: 1 },
      { op: "move", uid: "tuid-q", parent_uid: null, order_idx: 1 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-root"))!.children.map((n) => n.uid))
      .toEqual(["tuid-p", "tuid-x"]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-root", "tuid-q", "tuid-z"]);
    expect(findNode(r.blocks, uidOf("tuid-q"))!.children.map((n) => n.uid))
      .toEqual(["tuid-q1"]);
  });

  test("a run adopts trailing siblings under its last block", () => {
    const r = outdentSelection(gapTree(), P, [uidOf("tuid-s1"), uidOf("tuid-s2")]);
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-s1", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "tuid-s2", parent_uid: null, order_idx: 2 },
      { op: "move", uid: "tuid-s3", parent_uid: "tuid-s2", order_idx: 0 },
      { op: "move", uid: "tuid-s4", parent_uid: "tuid-s2", order_idx: 1 },
      { op: "move", uid: "tuid-s5", parent_uid: "tuid-s2", order_idx: 2 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-top", "tuid-s1", "tuid-s2"]);
    expect(findNode(r.blocks, uidOf("tuid-s2"))!.children.map((n) => n.uid))
      .toEqual(["tuid-s3", "tuid-s4", "tuid-s5"]);
    expect(findNode(r.blocks, uidOf("tuid-top"))!.children).toEqual([]);
  });

  test("split runs in one sibling group each adopt only their gap", () => {
    const r = outdentSelection(gapTree(), P, [uidOf("tuid-s2"), uidOf("tuid-s4")]);
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-s2", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "tuid-s3", parent_uid: "tuid-s2", order_idx: 0 },
      { op: "move", uid: "tuid-s4", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "tuid-s5", parent_uid: "tuid-s4", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-s2"))!.children.map((n) => n.uid))
      .toEqual(["tuid-s3"]);
    expect(findNode(r.blocks, uidOf("tuid-s4"))!.children.map((n) => n.uid))
      .toEqual(["tuid-s5"]);
  });

  test("a collapsed run tail expands when it adopts", () => {
    const t = gapTree();
    findNode(t, uidOf("tuid-s2"))!.collapsed = true;
    const r = outdentSelection(t, P, [uidOf("tuid-s1"), uidOf("tuid-s2")]);
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-s1", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "tuid-s2", parent_uid: null, order_idx: 2 },
      { op: "set_collapsed", uid: "tuid-s2", collapsed: false },
      { op: "move", uid: "tuid-s3", parent_uid: "tuid-s2", order_idx: 0 },
      { op: "move", uid: "tuid-s4", parent_uid: "tuid-s2", order_idx: 1 },
      { op: "move", uid: "tuid-s5", parent_uid: "tuid-s2", order_idx: 2 },
    ]);
  });

  test("one top-level root aborts every outdent run", () => {
    const t = selectionTree();
    const r = outdentSelection(t, P, [uidOf("tuid-a1"), uidOf("tuid-a1x"), uidOf("tuid-b"), uidOf("tuid-b1")]);

    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });

  test("empty or missing selections are no-ops", () => {
    const t = selectionTree();
    expect(indentSelection(t, P, []).ops).toEqual([]);
    expect(outdentSelection(t, P, []).ops).toEqual([]);
    expect(indentSelection(t, P, [uidOf("missing")]).ops).toEqual([]);
    expect(outdentSelection(t, P, [uidOf("missing")]).ops).toEqual([]);
  });
});

describe("moveBlockUp / moveBlockDown", () => {
  test("up swaps with previous sibling (insert before it)", () => {
    const r = moveBlockUp(tree(), P, uidOf("tuid-b2"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b2", parent_uid: "tuid-b", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["tuid-b2", "tuid-b1"]);
  });

  test("down inserts before the block after next ([a,b,c]: a -> before c)", () => {
    const r = moveBlockDown(tree(), P, uidOf("tuid-a"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-a", parent_uid: null, order_idx: 7 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-b", "tuid-a", "tuid-c"]);
  });

  test("down from the second-to-last lands last", () => {
    const r = moveBlockDown(tree(), P, uidOf("tuid-b"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b", parent_uid: null, order_idx: 8 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-a", "tuid-c", "tuid-b"]);
  });

  test("edges are no-ops", () => {
    expect(moveBlockUp(tree(), P, uidOf("tuid-a")).ops).toEqual([]);
    expect(moveBlockDown(tree(), P, uidOf("tuid-c")).ops).toEqual([]);
  });
});

// Three levels deep so cross-parent moves and the "would become shallower"
// no-op can both be exercised: a / b(b1(b1x) b2) / c.
const deepTree = () => [
  block("tuid-a", "alpha", { order_idx: orderIdxOf(0) }),
  block("tuid-b", "beta", {
    order_idx: orderIdxOf(5),
    children: [
      block("tuid-b1", "b-one", {
        order_idx: orderIdxOf(0),
        children: [block("tuid-b1x", "b-one-ex", { order_idx: orderIdxOf(0) })],
      }),
      block("tuid-b2", "b-two", { order_idx: orderIdxOf(3) }),
    ],
  }),
  block("tuid-c", "gamma", { order_idx: orderIdxOf(7) }),
];

const selectedMoveTree = () => [
  block("tuid-left", "Left", {
    order_idx: orderIdxOf(0),
    children: [block("tuid-left0", "Left child", { order_idx: orderIdxOf(0) })],
  }),
  block("source", "Source", {
    order_idx: orderIdxOf(1),
    children: [
      block("tuid-first", "First", {
        order_idx: orderIdxOf(0),
        children: [block("first0", "First child", { order_idx: orderIdxOf(0) })],
      }),
      block("second", "Second", { order_idx: orderIdxOf(1) }),
    ],
  }),
  block("tuid-right", "Right", {
    order_idx: orderIdxOf(2),
    children: [block("right0", "Right child", { order_idx: orderIdxOf(0) })],
  }),
];

const selectedDestinationTree = () => [
  block("tuid-a", "A", { order_idx: orderIdxOf(0) }),
  block("tuid-b", "B", {
    order_idx: orderIdxOf(1),
    collapsed: true,
    children: [block("tuid-b0", "B child", { order_idx: orderIdxOf(0) })],
  }),
  block("tuid-c", "C", {
    order_idx: orderIdxOf(2),
    children: [
      block("tuid-c0", "C first", { order_idx: orderIdxOf(0) }),
      block("tuid-c1", "C second", { order_idx: orderIdxOf(1) }),
    ],
  }),
];

describe("moveSubtreeUp / moveSubtreeDown", () => {
  test("up: a previous sibling means a plain sibling swap", () => {
    const r = moveSubtreeUp(deepTree(), P, uidOf("tuid-b2"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b2", parent_uid: "tuid-b", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["tuid-b2", "tuid-b1"]);
  });

  test("up: no previous sibling, parent has one — becomes its last child", () => {
    const r = moveSubtreeUp(deepTree(), P, uidOf("tuid-b1"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b1", parent_uid: "tuid-a", order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-a", "tuid-b", "tuid-c"]);
    expect(findNode(r.blocks, uidOf("tuid-a"))!.children.map((n) => n.uid)).toEqual(["tuid-b1"]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid)).toEqual(["tuid-b2"]);
    // subtree carried intact: b1's own child comes along
    expect(findNode(r.blocks, uidOf("tuid-b1"))!.children.map((n) => n.uid)).toEqual(["tuid-b1x"]);
  });

  test("up: top-level block with no previous sibling is a no-op", () => {
    const r = moveSubtreeUp(deepTree(), P, uidOf("tuid-a"));
    expect(r.ops).toEqual([]);
    expect(r.blocks).toEqual(deepTree());
  });

  test("up: level-3 block whose parent has no previous sibling is a no-op " +
       "(escaping further would make it level 1)", () => {
    const r = moveSubtreeUp(deepTree(), P, uidOf("tuid-b1x"));
    expect(r.ops).toEqual([]);
    expect(r.blocks).toEqual(deepTree());
  });

  test("down: a next sibling means a plain sibling swap", () => {
    const r = moveSubtreeDown(deepTree(), P, uidOf("tuid-b1"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b1", parent_uid: "tuid-b", order_idx: 4 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["tuid-b2", "tuid-b1"]);
    expect(findNode(r.blocks, uidOf("tuid-b1"))!.children.map((n) => n.uid)).toEqual(["tuid-b1x"]);
  });

  test("down: no next sibling, parent has one — becomes its first child", () => {
    const r = moveSubtreeDown(deepTree(), P, uidOf("tuid-b2"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b2", parent_uid: "tuid-c", order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-a", "tuid-b", "tuid-c"]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid)).toEqual(["tuid-b1"]);
    expect(findNode(r.blocks, uidOf("tuid-c"))!.children.map((n) => n.uid)).toEqual(["tuid-b2"]);
  });

  test("down: top-level block with no next sibling is a no-op", () => {
    const r = moveSubtreeDown(deepTree(), P, uidOf("tuid-c"));
    expect(r.ops).toEqual([]);
    expect(r.blocks).toEqual(deepTree());
  });

  test("down: level-3 block whose parent has no next sibling escape is not " +
       "a no-op here — the parent DOES have one, so it becomes b2's first " +
       "child, still depth-preserving", () => {
    const r = moveSubtreeDown(deepTree(), P, uidOf("tuid-b1x"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b1x", parent_uid: "tuid-b2", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-b1"))!.children).toEqual([]);
    expect(findNode(r.blocks, uidOf("tuid-b2"))!.children.map((n) => n.uid)).toEqual(["tuid-b1x"]);
  });

  test("up: a collapsed destination P is expanded — otherwise the moved " +
       "block would be hidden and lose focus", () => {
    const t = deepTree();
    findNode(t, uidOf("tuid-a"))!.collapsed = true;
    const r = moveSubtreeUp(t, P, uidOf("tuid-b1"));
    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "tuid-a", collapsed: false },
      { op: "move", uid: "tuid-b1", parent_uid: "tuid-a", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-a"))!.collapsed).toBe(false);
    expect(findNode(r.blocks, uidOf("tuid-a"))!.children.map((n) => n.uid)).toEqual(["tuid-b1"]);
  });

  test("down: a collapsed destination N is expanded — otherwise the moved " +
       "block would be hidden and lose focus", () => {
    const t = deepTree();
    findNode(t, uidOf("tuid-c"))!.collapsed = true;
    const r = moveSubtreeDown(t, P, uidOf("tuid-b2"));
    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "tuid-c", collapsed: false },
      { op: "move", uid: "tuid-b2", parent_uid: "tuid-c", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-c"))!.collapsed).toBe(false);
    expect(findNode(r.blocks, uidOf("tuid-c"))!.children.map((n) => n.uid)).toEqual(["tuid-b2"]);
  });

  test("up: destination P already has children — the block simply joins as " +
       "the new last", () => {
    const t = deepTree();
    findNode(t, uidOf("tuid-a"))!.children.push(block("tuid-ax", "a-ex", { order_idx: orderIdxOf(0) }));
    const r = moveSubtreeUp(t, P, uidOf("tuid-b1"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b1", parent_uid: "tuid-a", order_idx: 1 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-a"))!.children.map((n) => n.uid)).toEqual(["tuid-ax", "tuid-b1"]);
  });

  test("down: destination N already has children — the block lands FIRST, " +
       "existing children shift (shiftFrom path)", () => {
    const t = deepTree();
    findNode(t, uidOf("tuid-c"))!.children.push(block("tuid-cx", "c-ex", { order_idx: orderIdxOf(0) }));
    const r = moveSubtreeDown(t, P, uidOf("tuid-b2"));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b2", parent_uid: "tuid-c", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-c"))!.children.map((n) => n.uid)).toEqual(["tuid-b2", "tuid-cx"]);
  });

  test("unknown uid is a no-op", () => {
    expect(moveSubtreeUp(deepTree(), P, uidOf("tuid-zz")).ops).toEqual([]);
    expect(moveSubtreeDown(deepTree(), P, uidOf("tuid-zz")).ops).toEqual([]);
  });
});

describe("moveSelectionUp / moveSelectionDown", () => {
  test("up: a same-parent run swaps with the sibling above", () => {
    const r = moveSelectionUp(tree(), P, [uidOf("tuid-b"), uidOf("tuid-c")]);
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-a", parent_uid: null, order_idx: 8 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-b", "tuid-c", "tuid-a"]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["tuid-b1", "tuid-b2"]);
  });

  test("down: a same-parent run swaps with the sibling below", () => {
    const r = moveSelectionDown(tree(), P, [uidOf("tuid-a"), uidOf("tuid-b")]);
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-c", parent_uid: null, order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-c", "tuid-a", "tuid-b"]);
  });

  test("up: an edge run becomes the previous parent's last children", () => {
    const r = moveSelectionUp(
      selectedMoveTree(), P, [uidOf("tuid-first"), uidOf("first0"), uidOf("second")],
    );

    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-first", parent_uid: "tuid-left", order_idx: 1 },
      { op: "move", uid: "second", parent_uid: "tuid-left", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-left"))!.children.map((n) => n.uid))
      .toEqual(["tuid-left0", "tuid-first", "second"]);
    expect(findNode(r.blocks, uidOf("source"))!.children).toEqual([]);
    expect(findNode(r.blocks, uidOf("tuid-first"))!.children.map((n) => n.uid))
      .toEqual(["first0"]);
  });

  test("down: a collapsed root carries hidden descendants without expanding", () => {
    const t = selectedMoveTree();
    findNode(t, uidOf("tuid-first"))!.collapsed = true;

    const r = moveSelectionDown(t, P, [uidOf("tuid-first"), uidOf("second")]);

    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-first", parent_uid: "tuid-right", order_idx: 0 },
      { op: "move", uid: "second", parent_uid: "tuid-right", order_idx: 1 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-right"))!.children.map((n) => n.uid))
      .toEqual(["tuid-first", "second", "right0"]);
    expect(findNode(r.blocks, uidOf("source"))!.children).toEqual([]);
    expect(findNode(r.blocks, uidOf("tuid-first"))!.collapsed).toBe(true);
    expect(findNode(r.blocks, uidOf("tuid-first"))!.children.map((n) => n.uid))
      .toEqual(["first0"]);
  });

  test("up: a collapsed selected root that a run crosses into is expanded", () => {
    const r = moveSelectionUp(selectedDestinationTree(), P, [uidOf("tuid-b"), uidOf("tuid-c0"), uidOf("tuid-c1")]);

    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-a", parent_uid: null, order_idx: 2 },
      { op: "set_collapsed", uid: "tuid-b", collapsed: false },
      { op: "move", uid: "tuid-c0", parent_uid: "tuid-b", order_idx: 1 },
      { op: "move", uid: "tuid-c1", parent_uid: "tuid-b", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.collapsed).toBe(false);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["tuid-b0", "tuid-c0", "tuid-c1"]);
  });

  test("down: a collapsed selected root that a run crosses into is expanded", () => {
    const t = [
      block("tuid-a", "A", {
        order_idx: orderIdxOf(0),
        children: [
          block("tuid-a1", "A first", { order_idx: orderIdxOf(0) }),
          block("tuid-a2", "A second", { order_idx: orderIdxOf(1) }),
        ],
      }),
      block("tuid-b", "B", {
        order_idx: orderIdxOf(1),
        collapsed: true,
        children: [block("tuid-b1", "B child", { order_idx: orderIdxOf(0) })],
      }),
      block("tuid-c", "C", { order_idx: orderIdxOf(2) }),
    ];

    const r = moveSelectionDown(t, P, [uidOf("tuid-a2"), uidOf("tuid-b")]);

    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "tuid-b", collapsed: false },
      { op: "move", uid: "tuid-a2", parent_uid: "tuid-b", order_idx: 0 },
      { op: "move", uid: "tuid-c", parent_uid: null, order_idx: 1 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-a", "tuid-c", "tuid-b"]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.collapsed).toBe(false);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["tuid-a2", "tuid-b1"]);
  });

  test("moves eligible mixed-depth runs from original positions", () => {
    const r = moveSelectionUp(selectionTree(), P, [uidOf("tuid-a1"), uidOf("tuid-b")]);

    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-a0", parent_uid: "tuid-a", order_idx: 2 },
      { op: "move", uid: "tuid-a", parent_uid: null, order_idx: 2 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-b", "tuid-a", "tuid-c"]);
    expect(findNode(r.blocks, uidOf("tuid-a"))!.children.map((n) => n.uid))
      .toEqual(["tuid-a1", "tuid-a0"]);
    expect(findNode(r.blocks, uidOf("tuid-a1"))!.children.map((n) => n.uid))
      .toEqual(["tuid-a1x"]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["tuid-b1"]);
  });

  test("one ineligible run aborts every mixed-depth run", () => {
    const t = selectionTree();
    const r = moveSelectionUp(t, P, [uidOf("tuid-a0"), uidOf("tuid-b")]);

    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });

  test("expands a collapsed cross-parent destination before its moves", () => {
    const t = selectedMoveTree();
    findNode(t, uidOf("tuid-left"))!.collapsed = true;

    const r = moveSelectionUp(t, P, [uidOf("tuid-first"), uidOf("second")]);

    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "tuid-left", collapsed: false },
      { op: "move", uid: "tuid-first", parent_uid: "tuid-left", order_idx: 1 },
      { op: "move", uid: "second", parent_uid: "tuid-left", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-left"))!.collapsed).toBe(false);
  });

  test("empty and unknown selections are no-ops", () => {
    const t = selectedMoveTree();
    expect(moveSelectionUp(t, P, []).ops).toEqual([]);
    expect(moveSelectionDown(t, P, []).ops).toEqual([]);
    expect(moveSelectionUp(t, P, [uidOf("missing")]).ops).toEqual([]);
    expect(moveSelectionDown(t, P, [uidOf("missing")]).ops).toEqual([]);
  });
});

describe("moveBlocksTo", () => {
  test("moves every uid to the target as a contiguous run, order preserved", () => {
    // drop [b, c] at the very top: one move op per block, sequential slots
    const r = moveBlocksTo(tree(), P, [uidOf("tuid-b"), uidOf("tuid-c")], null, orderIdxOf(0));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b", parent_uid: null, order_idx: 0 },
      { op: "move", uid: "tuid-c", parent_uid: null, order_idx: 1 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-b", "tuid-c", "tuid-a"]);
    // b keeps its subtree through the move
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["tuid-b1", "tuid-b2"]);
  });

  test("reparents a cross-parent root run, order preserved", () => {
    // b's children dragged out to the top level
    const r = moveBlocksTo(tree(), P, [uidOf("tuid-b1"), uidOf("tuid-b2")], null, orderIdxOf(0));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b1", parent_uid: null, order_idx: 0 },
      { op: "move", uid: "tuid-b2", parent_uid: null, order_idx: 1 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-b1", "tuid-b2", "tuid-a", "tuid-b", "tuid-c"]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children).toEqual([]);
  });

  test("a selected parent + its child moves only the parent (subtree comes along)", () => {
    const r = moveBlocksTo(tree(), P, [uidOf("tuid-b"), uidOf("tuid-b1")], null, orderIdxOf(0));
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-b", parent_uid: null, order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-b", "tuid-a", "tuid-c"]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["tuid-b1", "tuid-b2"]);
  });

  test("moving into a new parent block", () => {
    const r = moveBlocksTo(tree(), P, [uidOf("tuid-a"), uidOf("tuid-c")], uidOf("tuid-b"),
      orderIdxOf(4)); // after b2 (idx 3)
    expect(r.ops).toEqual([
      { op: "move", uid: "tuid-a", parent_uid: "tuid-b", order_idx: 4 },
      { op: "move", uid: "tuid-c", parent_uid: "tuid-b", order_idx: 5 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-b"]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(["tuid-b1", "tuid-b2", "tuid-a", "tuid-c"]);
  });

  test("empty uids is a no-op", () => {
    expect(moveBlocksTo(tree(), P, [], null, orderIdxOf(0)).ops).toEqual([]);
  });
});

describe("deleteSelection", () => {
  test("deletes every selected top-level block, focus on the sibling after", () => {
    const r = deleteSelection(tree(), P, [uidOf("tuid-a"), uidOf("tuid-b")]);
    expect(r.ops).toEqual([
      { op: "delete", uid: "tuid-a" },
      { op: "delete", uid: "tuid-b" },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-c"]);
    expect(r.focus).toEqual({ uid: "tuid-c", cursor: 0 });
  });

  test("a selected parent + its child only emits one delete (child cascades away)", () => {
    const r = deleteSelection(tree(), P, [uidOf("tuid-b"), uidOf("tuid-b1")]);
    expect(r.ops).toEqual([{ op: "delete", uid: "tuid-b" }]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["tuid-a", "tuid-c"]);
    expect(r.focus).toEqual({ uid: "tuid-a", cursor: 5 }); // "alpha".length
  });

  test("focus falls back to the visible block before the run", () => {
    const r = deleteSelection(tree(), P, [uidOf("tuid-c")]);
    expect(r.ops).toEqual([{ op: "delete", uid: "tuid-c" }]);
    expect(r.focus).toEqual({ uid: "tuid-b2", cursor: 5 }); // "b-two".length
  });

  test("empty selection is a no-op", () => {
    expect(deleteSelection(tree(), P, []).ops).toEqual([]);
  });
});

describe("backspaceAtStart", () => {
  test("merges a childless block into its childless previous sibling", () => {
    const t = [block("tuid-x", "one", { order_idx: orderIdxOf(0) }),
               block("tuid-y", "two", { order_idx: orderIdxOf(1) })];
    const r = backspaceAtStart(t, P, uidOf("tuid-y"));
    expect(r.ops).toEqual([
      { op: "update_text", uid: "tuid-x", text: "onetwo" },
      { op: "delete", uid: "tuid-y" },
    ]);
    expect(r.focus).toEqual({ uid: "tuid-x", cursor: 3 });
  });

  test("empty block after a structured sibling: deleted, focus on last visible descendant", () => {
    const base = tree();
    // d sits between b (has children) and c
    const t = [base[0], base[1], block("tuid-d", "", { order_idx: orderIdxOf(6) }), base[2]];
    const r = backspaceAtStart(t, P, uidOf("tuid-d"));
    expect(r.ops).toEqual([{ op: "delete", uid: "tuid-d" }]);
    expect(r.focus).toEqual({ uid: "tuid-b2", cursor: 5 }); // "b-two".length
  });

  test("no-ops: non-empty first sibling, block with children, non-empty after structured prev", () => {
    expect(backspaceAtStart(tree(), P, uidOf("tuid-a")).ops).toEqual([]);
    expect(backspaceAtStart(tree(), P, uidOf("tuid-b1")).ops).toEqual([]); // first child, has text
    expect(backspaceAtStart(tree(), P, uidOf("tuid-b")).ops).toEqual([]);  // has children
    const t = [tree()[1], block("tuid-d", "text", { order_idx: orderIdxOf(6) })];
    expect(backspaceAtStart(t, P, uidOf("tuid-d")).ops).toEqual([]); // prev structured, not empty
  });

  test("empty first child: deleted, focus lands on the parent", () => {
    const t = [block("tuid-p", "parent", { order_idx: orderIdxOf(0), children: [
      block("tuid-k", "", { order_idx: orderIdxOf(0) }),
      block("tuid-k2", "sibling", { order_idx: orderIdxOf(1) }),
    ] })];
    const r = backspaceAtStart(t, P, uidOf("tuid-k"));
    expect(r.ops).toEqual([{ op: "delete", uid: "tuid-k" }]);
    expect(r.focus).toEqual({ uid: "tuid-p", cursor: 6 }); // "parent".length
    expect(findNode(r.blocks, uidOf("tuid-k"))).toBeNull();
  });

  test("empty first top-level block: deleted, focus lands on the next block", () => {
    const t = [block("tuid-x", "", { order_idx: orderIdxOf(0) }),
               block("tuid-y", "two", { order_idx: orderIdxOf(1) })];
    const r = backspaceAtStart(t, P, uidOf("tuid-x"));
    expect(r.ops).toEqual([{ op: "delete", uid: "tuid-x" }]);
    expect(r.focus).toEqual({ uid: "tuid-y", cursor: 0 });
  });

  test("sole empty block on the page: deleted, focus cleared", () => {
    const t = [block("tuid-x", "", { order_idx: orderIdxOf(0) })];
    const r = backspaceAtStart(t, P, uidOf("tuid-x"));
    expect(r.ops).toEqual([{ op: "delete", uid: "tuid-x" }]);
    expect(r.focus).toBeNull();
    expect(r.blocks).toEqual([]);
  });
});

describe("setCollapsed", () => {
  test("emits the op and applies it", () => {
    const r = setCollapsed(tree(), P, uidOf("tuid-b"), true);
    expect(r.ops).toEqual([{ op: "set_collapsed", uid: "tuid-b", collapsed: true }]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.collapsed).toBe(true);
  });

  test("no-op when the block already holds the value", () => {
    const t = [block("tuid-b", "beta", { collapsed: true })];
    const r = setCollapsed(t, P, uidOf("tuid-b"), true);
    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });
});

describe("revealBlock", () => {
  // g (collapsed) > m (expanded) > p (collapsed) > t, with the target t itself
  // collapsed over a child of its own.
  const nested = () => [
    block("tuid-g", "grandparent", { collapsed: true, children: [
      block("tuid-m", "middle", { children: [
        block("tuid-p", "parent", { collapsed: true, children: [
          block("tuid-t", "target", { collapsed: true, children: [block("tuid-tc", "under target")] }),
        ] }),
      ] }),
    ] }),
    block("tuid-after", "after"),
  ];

  test("expands every collapsed ancestor that hides the block, outermost first, in one batch", () => {
    const r = revealBlock(nested(), P, uidOf("tuid-t"));
    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "tuid-g", collapsed: false },
      { op: "set_collapsed", uid: "tuid-p", collapsed: false },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-g"))!.collapsed).toBe(false);
    expect(findNode(r.blocks, uidOf("tuid-p"))!.collapsed).toBe(false);
    // The target's own flag is not an ancestor's: it stays collapsed.
    expect(findNode(r.blocks, uidOf("tuid-t"))!.collapsed).toBe(true);
  });

  test("leaves focus where it is", () => {
    expect(revealBlock(nested(), P, uidOf("tuid-t")).focus).toBeNull();
  });

  test("a collapsed Roam table above the block shows its rows, so it stays collapsed", () => {
    const t = [
      block("tuid-g", "outer", { collapsed: true, children: [
        block("tuid-tbl", "{{table}}", { collapsed: true, children: [
          block("tuid-r1", "cell", { children: [block("tuid-r1b", "cell b")] }),
        ] }),
      ] }),
    ];
    const r = revealBlock(t, P, uidOf("tuid-r1b"));
    expect(r.ops).toEqual([{ op: "set_collapsed", uid: "tuid-g", collapsed: false }]);
    expect(findNode(r.blocks, uidOf("tuid-tbl"))!.collapsed).toBe(true);
  });

  test("no-op when nothing hides the block", () => {
    const t = [block("tuid-p", "parent", { children: [block("tuid-c", "child")] })];
    const r = revealBlock(t, P, uidOf("tuid-c"));
    expect(r).toEqual({ blocks: t, ops: [], focus: null });
    expect(r.blocks).toBe(t);
  });

  test("no-op for a top-level block, even a collapsed one", () => {
    const t = nested();
    expect(revealBlock(t, P, uidOf("tuid-after")).ops).toEqual([]);
    expect(revealBlock(t, P, uidOf("tuid-g")).blocks).toBe(t);
  });

  test("no-op when the block is not on the page", () => {
    const t = nested();
    const r = revealBlock(t, P, uidOf("elsewhere"));
    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });
});

describe("setHeading", () => {
  test("emits the op and applies it", () => {
    const r = setHeading(tree(), P, uidOf("tuid-b"), 2);
    expect(r.ops).toEqual([{ op: "set_heading", uid: "tuid-b", heading: 2 }]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.heading).toBe(2);
  });

  test("clearing back to plain text", () => {
    const r = setHeading([block("tuid-b", "beta", { heading: 2 })], P, uidOf("tuid-b"), null);
    expect(r.ops).toEqual([{ op: "set_heading", uid: "tuid-b", heading: null }]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.heading).toBeNull();
  });

  test("no-op when the block already holds the level", () => {
    const t = [block("tuid-b", "beta", { heading: 2 })];
    expect(setHeading(t, P, uidOf("tuid-b"), 2).ops).toEqual([]);
    expect(setHeading(tree(), P, uidOf("tuid-b"), null).ops).toEqual([]);
  });

  test("no-op for an unknown uid", () => {
    expect(setHeading(tree(), P, uidOf("tuid-ghost"), 1).ops).toEqual([]);
  });
});

describe("setViewType", () => {
  test("emits one op and applies it optimistically", () => {
    const r = setViewType(tree(), P, uidOf("tuid-b"), "numbered");
    expect(r.ops).toEqual([
      { op: "set_view_type", uid: "tuid-b", view_type: "numbered" },
    ]);
    expect(findNode(r.blocks, uidOf("tuid-b"))!.view_type).toBe("numbered");
    expect(findNode(r.blocks, uidOf("tuid-b"))!.text).toBe("beta");
  });

  test("explicit document mode and unknown-uid no-op", () => {
    const r = setViewType([block("tuid-b", "beta", { view_type: "numbered" })], P,
                          uidOf("tuid-b"), "document");
    expect(findNode(r.blocks, uidOf("tuid-b"))!.view_type).toBe("document");
    expect(setViewType(tree(), P, uidOf("tuid-ghost"), "numbered").ops).toEqual([]);
  });

  test("no-op when the block already holds the view type", () => {
    const t = [block("tuid-b", "beta", { view_type: "numbered" })];
    const r = setViewType(t, P, uidOf("tuid-b"), "numbered");
    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });

  test("document over the null default is a no-op: they render the same", () => {
    expect(findNode(tree(), uidOf("tuid-b"))!.view_type).toBeNull();
    expect(setViewType(tree(), P, uidOf("tuid-b"), "document").ops).toEqual([]);
  });
});
