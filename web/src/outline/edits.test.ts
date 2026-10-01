import { describe, expect, test } from "vitest";
import { block, title, uid } from "../test-helpers";
import { findNode } from "./tree";
import { backspaceAtStart, clampCaret, deleteSelection, indentBlock,
         indentSelection, moveBlockDown, moveBlocksTo, moveBlockUp,
         moveSelectionDown, moveSelectionUp, moveSubtreeDown, moveSubtreeUp,
         outdentBlock, outdentSelection, setCollapsed, setHeading,
         setViewType, splitBlock } from "./edits";

const someUid = uid("abcdef");

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

const P = title("Page");
const tree = () => [
  block("a", "alpha", { order_idx: 0 }),
  block("b", "beta", {
    order_idx: 5,
    children: [
      block("b1", "b-one", { order_idx: 0 }),
      block("b2", "b-two", { order_idx: 3 }),
    ],
  }),
  block("c", "gamma", { order_idx: 7 }),
];

const adoptionTree = () => [
  block("p", "parent", {
    order_idx: 0,
    children: [
      block("u", "u-block", {
        order_idx: 0,
        children: [block("u1", "u child", { order_idx: 4 })],
      }),
      block("s1", "sib one", { order_idx: 1 }),
      block("s2", "sib two", { order_idx: 2 }),
    ],
  }),
  block("z", "zed", { order_idx: 9 }),
];

describe("splitBlock", () => {
  test("mid-text: keeps head in place, tail becomes the next sibling, focus on new", () => {
    const r = splitBlock(tree(), P, uid("a"), 2, uid("new111"));
    expect(r.ops).toEqual([
      { op: "update_text", uid: "a", text: "al" },
      { op: "create", uid: "new111", page_title: P, parent_uid: null,
        order_idx: 5, text: "pha" }, // before b (order 5), server shifts b,c
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "new111", "b", "c"]);
    expect(r.focus).toEqual({ uid: "new111", cursor: 0 });
  });

  test("at end of a childless block: plain empty sibling, no update_text", () => {
    const r = splitBlock(tree(), P, uid("c"), 5, uid("new111"));
    expect(r.ops).toEqual([
      { op: "create", uid: "new111", page_title: P, parent_uid: null,
        order_idx: 8, text: "" },
    ]);
    expect(r.focus).toEqual({ uid: "new111", cursor: 0 });
  });

  test("at cursor 0 with text: empty block inserted ABOVE, uid keeps its text", () => {
    const r = splitBlock(tree(), P, uid("a"), 0, uid("new111"));
    expect(r.ops).toEqual([
      { op: "create", uid: "new111", page_title: P, parent_uid: null,
        order_idx: 0, text: "" },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["new111", "a", "b", "c"]);
    expect(r.focus).toEqual({ uid: "a", cursor: 0 });
  });

  test("on an expanded block with children: new block becomes first child", () => {
    const r = splitBlock(tree(), P, uid("b"), 4, uid("new111"));
    expect(r.ops).toEqual([
      { op: "create", uid: "new111", page_title: P, parent_uid: "b",
        order_idx: 0, text: "" },
    ]);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid))
      .toEqual(["new111", "b1", "b2"]);
  });

  test("unknown uid is a no-op", () => {
    const r = splitBlock(tree(), P, uid("zz"), 0, uid("new111"));
    expect(r.ops).toEqual([]);
  });
});

test("pageTitle and uid can't be swapped", () => {
  // @ts-expect-error (title, uid) swapped
  const r = indentBlock(tree(), someUid, "Page");
  expect(r.ops).toEqual([]);
});

test("a raw string can't stand in for the page's title", () => {
  // @ts-expect-error a raw string is not a CanonicalTitle
  const r = indentBlock(tree(), "Page", someUid);
  expect(r.ops).toEqual([]);
});

describe("indent / outdent", () => {
  test("indent moves under previous sibling, after its last child", () => {
    const r = indentBlock(tree(), P, uid("c"));
    expect(r.ops).toEqual([
      { op: "move", uid: "c", parent_uid: "b", order_idx: 4 }, // b2 is 3
    ]);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid))
      .toEqual(["b1", "b2", "c"]);
  });

  test("indent expands a collapsed new parent first", () => {
    const t = tree();
    findNode(t, uid("b"))!.collapsed = true;
    const r = indentBlock(t, P, uid("c"));
    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "b", collapsed: false },
      { op: "move", uid: "c", parent_uid: "b", order_idx: 4 },
    ]);
  });

  test("first sibling can't indent", () => {
    expect(indentBlock(tree(), P, uid("a")).ops).toEqual([]);
    expect(indentBlock(tree(), P, uid("b1")).ops).toEqual([]);
  });

  test("outdent lands after its old parent and adopts trailing siblings", () => {
    const r = outdentBlock(tree(), P, uid("b1"));
    expect(r.ops).toEqual([
      { op: "move", uid: "b1", parent_uid: null, order_idx: 7 }, // before c
      { op: "move", uid: "b2", parent_uid: "b1", order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "b", "b1", "c"]);
    expect(findNode(r.blocks, uid("b1"))!.children.map((n) => n.uid))
      .toEqual(["b2"]);
    expect(findNode(r.blocks, uid("b"))!.children).toEqual([]);
  });

  test("outdenting the last child emits no adoption ops", () => {
    const r = outdentBlock(tree(), P, uid("b2"));
    expect(r.ops).toEqual([
      { op: "move", uid: "b2", parent_uid: null, order_idx: 7 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "b", "b2", "c"]);
  });

  test("adopted siblings append after the block's existing children", () => {
    const r = outdentBlock(adoptionTree(), P, uid("u"));
    expect(r.ops).toEqual([
      { op: "move", uid: "u", parent_uid: null, order_idx: 9 }, // before z
      { op: "move", uid: "s1", parent_uid: "u", order_idx: 5 }, // u1 is 4
      { op: "move", uid: "s2", parent_uid: "u", order_idx: 6 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["p", "u", "z"]);
    expect(findNode(r.blocks, uid("u"))!.children.map((n) => n.uid))
      .toEqual(["u1", "s1", "s2"]);
    expect(findNode(r.blocks, uid("p"))!.children).toEqual([]);
  });

  test("a collapsed block expands when it adopts trailing siblings", () => {
    const t = adoptionTree();
    findNode(t, uid("u"))!.collapsed = true;
    const r = outdentBlock(t, P, uid("u"));
    expect(r.ops).toEqual([
      { op: "move", uid: "u", parent_uid: null, order_idx: 9 },
      { op: "set_collapsed", uid: "u", collapsed: false },
      { op: "move", uid: "s1", parent_uid: "u", order_idx: 5 },
      { op: "move", uid: "s2", parent_uid: "u", order_idx: 6 },
    ]);
  });

  test("no expand op when a collapsed block adopts nothing", () => {
    const t = tree();
    findNode(t, uid("b2"))!.collapsed = true;
    const r = outdentBlock(t, P, uid("b2"));
    expect(r.ops).toEqual([
      { op: "move", uid: "b2", parent_uid: null, order_idx: 7 },
    ]);
  });

  test("top-level blocks can't outdent", () => {
    expect(outdentBlock(tree(), P, uid("a")).ops).toEqual([]);
  });
});

const selectionTree = () => [
  block("a", "A", {
    order_idx: 0,
    children: [
      block("a0", "A zero", { order_idx: 0 }),
      block("a1", "A one", {
        order_idx: 1,
        children: [block("a1x", "A one child", { order_idx: 0 })],
      }),
    ],
  }),
  block("b", "B", {
    order_idx: 1,
    children: [block("b1", "B child", { order_idx: 0 })],
  }),
  block("c", "C", { order_idx: 2 }),
];

const mixedOutdentTree = () => [
  block("root", "Root", {
    order_idx: 0,
    children: [
      block("p", "P", {
        order_idx: 0,
        children: [
          block("p0", "P zero", { order_idx: 0 }),
          block("x", "X", { order_idx: 1 }),
        ],
      }),
      block("q", "Q", {
        order_idx: 1,
        children: [block("q1", "Q child", { order_idx: 0 })],
      }),
    ],
  }),
  block("z", "Z", { order_idx: 1 }),
];

const gapTree = () => [
  block("top", "top parent", {
    order_idx: 0,
    children: [
      block("s1", "one", { order_idx: 0 }),
      block("s2", "two", { order_idx: 1 }),
      block("s3", "three", { order_idx: 2 }),
      block("s4", "four", { order_idx: 3 }),
      block("s5", "five", { order_idx: 4 }),
    ],
  }),
];

describe("indentSelection / outdentSelection", () => {
  test("indents one sibling run under one parent without staircasing", () => {
    const r = indentSelection(selectionTree(), P, [uid("b"), uid("b1"), uid("c")]);

    expect(r.ops).toEqual([
      { op: "move", uid: "b", parent_uid: "a", order_idx: 2 },
      { op: "move", uid: "c", parent_uid: "a", order_idx: 3 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a"]);
    expect(findNode(r.blocks, uid("a"))!.children.map((n) => n.uid))
      .toEqual(["a0", "a1", "b", "c"]);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid))
      .toEqual(["b1"]);
  });

  test("indents mixed-level roots from original destinations by one level", () => {
    const r = indentSelection(selectionTree(), P, [uid("a1"), uid("a1x"), uid("b"), uid("b1")]);

    expect(r.ops).toEqual([
      { op: "move", uid: "a1", parent_uid: "a0", order_idx: 0 },
      { op: "move", uid: "b", parent_uid: "a", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, uid("a0"))!.children.map((n) => n.uid))
      .toEqual(["a1"]);
    expect(findNode(r.blocks, uid("a1"))!.children.map((n) => n.uid))
      .toEqual(["a1x"]);
    expect(findNode(r.blocks, uid("a"))!.children.map((n) => n.uid))
      .toEqual(["a0", "b"]);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid))
      .toEqual(["b1"]);
  });

  test("expands a collapsed destination once before moving its run", () => {
    const t = selectionTree();
    findNode(t, uid("a"))!.collapsed = true;

    const r = indentSelection(t, P, [uid("b"), uid("b1"), uid("c")]);

    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "a", collapsed: false },
      { op: "move", uid: "b", parent_uid: "a", order_idx: 2 },
      { op: "move", uid: "c", parent_uid: "a", order_idx: 3 },
    ]);
  });

  test("one first-sibling run aborts every indent run", () => {
    const t = selectionTree();
    const r = indentSelection(
      t, P, [uid("a0"), uid("a1"), uid("a1x"), uid("b"), uid("b1")],
    );

    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });

  test("outdents one sibling run consecutively after its former parent", () => {
    const r = outdentSelection(selectionTree(), P, [uid("a0"), uid("a1"), uid("a1x")]);

    expect(r.ops).toEqual([
      { op: "move", uid: "a0", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "a1", parent_uid: null, order_idx: 2 },
    ]);
    expect(r.blocks.map((n) => n.uid))
      .toEqual(["a", "a0", "a1", "b", "c"]);
    expect(findNode(r.blocks, uid("a1"))!.children.map((n) => n.uid))
      .toEqual(["a1x"]);
  });

  test("outdents mixed-level roots once while preserving their subtrees", () => {
    const r = outdentSelection(
      mixedOutdentTree(), P, [uid("x"), uid("q"), uid("q1")],
    );

    expect(r.ops).toEqual([
      { op: "move", uid: "x", parent_uid: "root", order_idx: 1 },
      { op: "move", uid: "q", parent_uid: null, order_idx: 1 },
    ]);
    expect(findNode(r.blocks, uid("root"))!.children.map((n) => n.uid))
      .toEqual(["p", "x"]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["root", "q", "z"]);
    expect(findNode(r.blocks, uid("q"))!.children.map((n) => n.uid))
      .toEqual(["q1"]);
  });

  test("a run adopts trailing siblings under its last block", () => {
    const r = outdentSelection(gapTree(), P, [uid("s1"), uid("s2")]);
    expect(r.ops).toEqual([
      { op: "move", uid: "s1", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "s2", parent_uid: null, order_idx: 2 },
      { op: "move", uid: "s3", parent_uid: "s2", order_idx: 0 },
      { op: "move", uid: "s4", parent_uid: "s2", order_idx: 1 },
      { op: "move", uid: "s5", parent_uid: "s2", order_idx: 2 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["top", "s1", "s2"]);
    expect(findNode(r.blocks, uid("s2"))!.children.map((n) => n.uid))
      .toEqual(["s3", "s4", "s5"]);
    expect(findNode(r.blocks, uid("top"))!.children).toEqual([]);
  });

  test("split runs in one sibling group each adopt only their gap", () => {
    const r = outdentSelection(gapTree(), P, [uid("s2"), uid("s4")]);
    expect(r.ops).toEqual([
      { op: "move", uid: "s2", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "s3", parent_uid: "s2", order_idx: 0 },
      { op: "move", uid: "s4", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "s5", parent_uid: "s4", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uid("s2"))!.children.map((n) => n.uid))
      .toEqual(["s3"]);
    expect(findNode(r.blocks, uid("s4"))!.children.map((n) => n.uid))
      .toEqual(["s5"]);
  });

  test("a collapsed run tail expands when it adopts", () => {
    const t = gapTree();
    findNode(t, uid("s2"))!.collapsed = true;
    const r = outdentSelection(t, P, [uid("s1"), uid("s2")]);
    expect(r.ops).toEqual([
      { op: "move", uid: "s1", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "s2", parent_uid: null, order_idx: 2 },
      { op: "set_collapsed", uid: "s2", collapsed: false },
      { op: "move", uid: "s3", parent_uid: "s2", order_idx: 0 },
      { op: "move", uid: "s4", parent_uid: "s2", order_idx: 1 },
      { op: "move", uid: "s5", parent_uid: "s2", order_idx: 2 },
    ]);
  });

  test("one top-level root aborts every outdent run", () => {
    const t = selectionTree();
    const r = outdentSelection(t, P, [uid("a1"), uid("a1x"), uid("b"), uid("b1")]);

    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });

  test("empty or missing selections are no-ops", () => {
    const t = selectionTree();
    expect(indentSelection(t, P, []).ops).toEqual([]);
    expect(outdentSelection(t, P, []).ops).toEqual([]);
    expect(indentSelection(t, P, [uid("missing")]).ops).toEqual([]);
    expect(outdentSelection(t, P, [uid("missing")]).ops).toEqual([]);
  });
});

describe("moveBlockUp / moveBlockDown", () => {
  test("up swaps with previous sibling (insert before it)", () => {
    const r = moveBlockUp(tree(), P, uid("b2"));
    expect(r.ops).toEqual([
      { op: "move", uid: "b2", parent_uid: "b", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid))
      .toEqual(["b2", "b1"]);
  });

  test("down inserts before the block after next ([a,b,c]: a -> before c)", () => {
    const r = moveBlockDown(tree(), P, uid("a"));
    expect(r.ops).toEqual([
      { op: "move", uid: "a", parent_uid: null, order_idx: 7 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "a", "c"]);
  });

  test("down from the second-to-last lands last", () => {
    const r = moveBlockDown(tree(), P, uid("b"));
    expect(r.ops).toEqual([
      { op: "move", uid: "b", parent_uid: null, order_idx: 8 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "c", "b"]);
  });

  test("edges are no-ops", () => {
    expect(moveBlockUp(tree(), P, uid("a")).ops).toEqual([]);
    expect(moveBlockDown(tree(), P, uid("c")).ops).toEqual([]);
  });
});

// Three levels deep so cross-parent moves and the "would become shallower"
// no-op can both be exercised: a / b(b1(b1x) b2) / c.
const deepTree = () => [
  block("a", "alpha", { order_idx: 0 }),
  block("b", "beta", {
    order_idx: 5,
    children: [
      block("b1", "b-one", {
        order_idx: 0,
        children: [block("b1x", "b-one-ex", { order_idx: 0 })],
      }),
      block("b2", "b-two", { order_idx: 3 }),
    ],
  }),
  block("c", "gamma", { order_idx: 7 }),
];

const selectedMoveTree = () => [
  block("left", "Left", {
    order_idx: 0,
    children: [block("left0", "Left child", { order_idx: 0 })],
  }),
  block("source", "Source", {
    order_idx: 1,
    children: [
      block("first", "First", {
        order_idx: 0,
        children: [block("first0", "First child", { order_idx: 0 })],
      }),
      block("second", "Second", { order_idx: 1 }),
    ],
  }),
  block("right", "Right", {
    order_idx: 2,
    children: [block("right0", "Right child", { order_idx: 0 })],
  }),
];

const selectedDestinationTree = () => [
  block("a", "A", { order_idx: 0 }),
  block("b", "B", {
    order_idx: 1,
    collapsed: true,
    children: [block("b0", "B child", { order_idx: 0 })],
  }),
  block("c", "C", {
    order_idx: 2,
    children: [
      block("c0", "C first", { order_idx: 0 }),
      block("c1", "C second", { order_idx: 1 }),
    ],
  }),
];

describe("moveSubtreeUp / moveSubtreeDown", () => {
  test("up: a previous sibling means a plain sibling swap", () => {
    const r = moveSubtreeUp(deepTree(), P, uid("b2"));
    expect(r.ops).toEqual([
      { op: "move", uid: "b2", parent_uid: "b", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid))
      .toEqual(["b2", "b1"]);
  });

  test("up: no previous sibling, parent has one — becomes its last child", () => {
    const r = moveSubtreeUp(deepTree(), P, uid("b1"));
    expect(r.ops).toEqual([
      { op: "move", uid: "b1", parent_uid: "a", order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "b", "c"]);
    expect(findNode(r.blocks, uid("a"))!.children.map((n) => n.uid)).toEqual(["b1"]);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid)).toEqual(["b2"]);
    // subtree carried intact: b1's own child comes along
    expect(findNode(r.blocks, uid("b1"))!.children.map((n) => n.uid)).toEqual(["b1x"]);
  });

  test("up: top-level block with no previous sibling is a no-op", () => {
    const r = moveSubtreeUp(deepTree(), P, uid("a"));
    expect(r.ops).toEqual([]);
    expect(r.blocks).toEqual(deepTree());
  });

  test("up: level-3 block whose parent has no previous sibling is a no-op " +
       "(escaping further would make it level 1)", () => {
    const r = moveSubtreeUp(deepTree(), P, uid("b1x"));
    expect(r.ops).toEqual([]);
    expect(r.blocks).toEqual(deepTree());
  });

  test("down: a next sibling means a plain sibling swap", () => {
    const r = moveSubtreeDown(deepTree(), P, uid("b1"));
    expect(r.ops).toEqual([
      { op: "move", uid: "b1", parent_uid: "b", order_idx: 4 },
    ]);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid))
      .toEqual(["b2", "b1"]);
    expect(findNode(r.blocks, uid("b1"))!.children.map((n) => n.uid)).toEqual(["b1x"]);
  });

  test("down: no next sibling, parent has one — becomes its first child", () => {
    const r = moveSubtreeDown(deepTree(), P, uid("b2"));
    expect(r.ops).toEqual([
      { op: "move", uid: "b2", parent_uid: "c", order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "b", "c"]);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid)).toEqual(["b1"]);
    expect(findNode(r.blocks, uid("c"))!.children.map((n) => n.uid)).toEqual(["b2"]);
  });

  test("down: top-level block with no next sibling is a no-op", () => {
    const r = moveSubtreeDown(deepTree(), P, uid("c"));
    expect(r.ops).toEqual([]);
    expect(r.blocks).toEqual(deepTree());
  });

  test("down: level-3 block whose parent has no next sibling escape is not " +
       "a no-op here — the parent DOES have one, so it becomes b2's first " +
       "child, still depth-preserving", () => {
    const r = moveSubtreeDown(deepTree(), P, uid("b1x"));
    expect(r.ops).toEqual([
      { op: "move", uid: "b1x", parent_uid: "b2", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uid("b1"))!.children).toEqual([]);
    expect(findNode(r.blocks, uid("b2"))!.children.map((n) => n.uid)).toEqual(["b1x"]);
  });

  test("up: a collapsed destination P is expanded — otherwise the moved " +
       "block would be hidden and lose focus", () => {
    const t = deepTree();
    findNode(t, uid("a"))!.collapsed = true;
    const r = moveSubtreeUp(t, P, uid("b1"));
    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "a", collapsed: false },
      { op: "move", uid: "b1", parent_uid: "a", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uid("a"))!.collapsed).toBe(false);
    expect(findNode(r.blocks, uid("a"))!.children.map((n) => n.uid)).toEqual(["b1"]);
  });

  test("down: a collapsed destination N is expanded — otherwise the moved " +
       "block would be hidden and lose focus", () => {
    const t = deepTree();
    findNode(t, uid("c"))!.collapsed = true;
    const r = moveSubtreeDown(t, P, uid("b2"));
    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "c", collapsed: false },
      { op: "move", uid: "b2", parent_uid: "c", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uid("c"))!.collapsed).toBe(false);
    expect(findNode(r.blocks, uid("c"))!.children.map((n) => n.uid)).toEqual(["b2"]);
  });

  test("up: destination P already has children — the block simply joins as " +
       "the new last", () => {
    const t = deepTree();
    findNode(t, uid("a"))!.children.push(block("ax", "a-ex", { order_idx: 0 }));
    const r = moveSubtreeUp(t, P, uid("b1"));
    expect(r.ops).toEqual([
      { op: "move", uid: "b1", parent_uid: "a", order_idx: 1 },
    ]);
    expect(findNode(r.blocks, uid("a"))!.children.map((n) => n.uid)).toEqual(["ax", "b1"]);
  });

  test("down: destination N already has children — the block lands FIRST, " +
       "existing children shift (shiftFrom path)", () => {
    const t = deepTree();
    findNode(t, uid("c"))!.children.push(block("cx", "c-ex", { order_idx: 0 }));
    const r = moveSubtreeDown(t, P, uid("b2"));
    expect(r.ops).toEqual([
      { op: "move", uid: "b2", parent_uid: "c", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, uid("c"))!.children.map((n) => n.uid)).toEqual(["b2", "cx"]);
  });

  test("unknown uid is a no-op", () => {
    expect(moveSubtreeUp(deepTree(), P, uid("zz")).ops).toEqual([]);
    expect(moveSubtreeDown(deepTree(), P, uid("zz")).ops).toEqual([]);
  });
});

describe("moveSelectionUp / moveSelectionDown", () => {
  test("up: a same-parent run swaps with the sibling above", () => {
    const r = moveSelectionUp(tree(), P, [uid("b"), uid("c")]);
    expect(r.ops).toEqual([
      { op: "move", uid: "a", parent_uid: null, order_idx: 8 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "c", "a"]);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid))
      .toEqual(["b1", "b2"]);
  });

  test("down: a same-parent run swaps with the sibling below", () => {
    const r = moveSelectionDown(tree(), P, [uid("a"), uid("b")]);
    expect(r.ops).toEqual([
      { op: "move", uid: "c", parent_uid: null, order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["c", "a", "b"]);
  });

  test("up: an edge run becomes the previous parent's last children", () => {
    const r = moveSelectionUp(
      selectedMoveTree(), P, [uid("first"), uid("first0"), uid("second")],
    );

    expect(r.ops).toEqual([
      { op: "move", uid: "first", parent_uid: "left", order_idx: 1 },
      { op: "move", uid: "second", parent_uid: "left", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, uid("left"))!.children.map((n) => n.uid))
      .toEqual(["left0", "first", "second"]);
    expect(findNode(r.blocks, uid("source"))!.children).toEqual([]);
    expect(findNode(r.blocks, uid("first"))!.children.map((n) => n.uid))
      .toEqual(["first0"]);
  });

  test("down: a collapsed root carries hidden descendants without expanding", () => {
    const t = selectedMoveTree();
    findNode(t, uid("first"))!.collapsed = true;

    const r = moveSelectionDown(t, P, [uid("first"), uid("second")]);

    expect(r.ops).toEqual([
      { op: "move", uid: "first", parent_uid: "right", order_idx: 0 },
      { op: "move", uid: "second", parent_uid: "right", order_idx: 1 },
    ]);
    expect(findNode(r.blocks, uid("right"))!.children.map((n) => n.uid))
      .toEqual(["first", "second", "right0"]);
    expect(findNode(r.blocks, uid("source"))!.children).toEqual([]);
    expect(findNode(r.blocks, uid("first"))!.collapsed).toBe(true);
    expect(findNode(r.blocks, uid("first"))!.children.map((n) => n.uid))
      .toEqual(["first0"]);
  });

  test("up: a collapsed selected destination root stays collapsed", () => {
    const r = moveSelectionUp(selectedDestinationTree(), P, [uid("b"), uid("c0"), uid("c1")]);

    expect(r.ops).toEqual([
      { op: "move", uid: "a", parent_uid: null, order_idx: 2 },
      { op: "move", uid: "c0", parent_uid: "b", order_idx: 1 },
      { op: "move", uid: "c1", parent_uid: "b", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, uid("b"))!.collapsed).toBe(true);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid))
      .toEqual(["b0", "c0", "c1"]);
  });

  test("moves eligible mixed-depth runs from original positions", () => {
    const r = moveSelectionUp(selectionTree(), P, [uid("a1"), uid("b")]);

    expect(r.ops).toEqual([
      { op: "move", uid: "a0", parent_uid: "a", order_idx: 2 },
      { op: "move", uid: "a", parent_uid: null, order_idx: 2 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "a", "c"]);
    expect(findNode(r.blocks, uid("a"))!.children.map((n) => n.uid))
      .toEqual(["a1", "a0"]);
    expect(findNode(r.blocks, uid("a1"))!.children.map((n) => n.uid))
      .toEqual(["a1x"]);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid))
      .toEqual(["b1"]);
  });

  test("one ineligible run aborts every mixed-depth run", () => {
    const t = selectionTree();
    const r = moveSelectionUp(t, P, [uid("a0"), uid("b")]);

    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });

  test("expands a collapsed cross-parent destination before its moves", () => {
    const t = selectedMoveTree();
    findNode(t, uid("left"))!.collapsed = true;

    const r = moveSelectionUp(t, P, [uid("first"), uid("second")]);

    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "left", collapsed: false },
      { op: "move", uid: "first", parent_uid: "left", order_idx: 1 },
      { op: "move", uid: "second", parent_uid: "left", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, uid("left"))!.collapsed).toBe(false);
  });

  test("empty and unknown selections are no-ops", () => {
    const t = selectedMoveTree();
    expect(moveSelectionUp(t, P, []).ops).toEqual([]);
    expect(moveSelectionDown(t, P, []).ops).toEqual([]);
    expect(moveSelectionUp(t, P, [uid("missing")]).ops).toEqual([]);
    expect(moveSelectionDown(t, P, [uid("missing")]).ops).toEqual([]);
  });
});

describe("moveBlocksTo", () => {
  test("moves every uid to the target as a contiguous run, order preserved", () => {
    // drop [b, c] at the very top: one move op per block, sequential slots
    const r = moveBlocksTo(tree(), P, [uid("b"), uid("c")], null, 0);
    expect(r.ops).toEqual([
      { op: "move", uid: "b", parent_uid: null, order_idx: 0 },
      { op: "move", uid: "c", parent_uid: null, order_idx: 1 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "c", "a"]);
    // b keeps its subtree through the move
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid))
      .toEqual(["b1", "b2"]);
  });

  test("reparents a cross-parent root run, order preserved", () => {
    // b's children dragged out to the top level
    const r = moveBlocksTo(tree(), P, [uid("b1"), uid("b2")], null, 0);
    expect(r.ops).toEqual([
      { op: "move", uid: "b1", parent_uid: null, order_idx: 0 },
      { op: "move", uid: "b2", parent_uid: null, order_idx: 1 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b1", "b2", "a", "b", "c"]);
    expect(findNode(r.blocks, uid("b"))!.children).toEqual([]);
  });

  test("a selected parent + its child moves only the parent (subtree comes along)", () => {
    const r = moveBlocksTo(tree(), P, [uid("b"), uid("b1")], null, 0);
    expect(r.ops).toEqual([
      { op: "move", uid: "b", parent_uid: null, order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "a", "c"]);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid))
      .toEqual(["b1", "b2"]);
  });

  test("moving into a new parent block", () => {
    const r = moveBlocksTo(tree(), P, [uid("a"), uid("c")], uid("b"), 4); // after b2 (idx 3)
    expect(r.ops).toEqual([
      { op: "move", uid: "a", parent_uid: "b", order_idx: 4 },
      { op: "move", uid: "c", parent_uid: "b", order_idx: 5 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b"]);
    expect(findNode(r.blocks, uid("b"))!.children.map((n) => n.uid))
      .toEqual(["b1", "b2", "a", "c"]);
  });

  test("empty uids is a no-op", () => {
    expect(moveBlocksTo(tree(), P, [], null, 0).ops).toEqual([]);
  });
});

describe("deleteSelection", () => {
  test("deletes every selected top-level block, focus on the sibling after", () => {
    const r = deleteSelection(tree(), P, [uid("a"), uid("b")]);
    expect(r.ops).toEqual([
      { op: "delete", uid: "a" },
      { op: "delete", uid: "b" },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["c"]);
    expect(r.focus).toEqual({ uid: "c", cursor: 0 });
  });

  test("a selected parent + its child only emits one delete (child cascades away)", () => {
    const r = deleteSelection(tree(), P, [uid("b"), uid("b1")]);
    expect(r.ops).toEqual([{ op: "delete", uid: "b" }]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "c"]);
    expect(r.focus).toEqual({ uid: "a", cursor: 5 }); // "alpha".length
  });

  test("focus falls back to the visible block before the run", () => {
    const r = deleteSelection(tree(), P, [uid("c")]);
    expect(r.ops).toEqual([{ op: "delete", uid: "c" }]);
    expect(r.focus).toEqual({ uid: "b2", cursor: 5 }); // "b-two".length
  });

  test("empty selection is a no-op", () => {
    expect(deleteSelection(tree(), P, []).ops).toEqual([]);
  });
});

describe("backspaceAtStart", () => {
  test("merges a childless block into its childless previous sibling", () => {
    const t = [block("x", "one", { order_idx: 0 }),
               block("y", "two", { order_idx: 1 })];
    const r = backspaceAtStart(t, P, uid("y"));
    expect(r.ops).toEqual([
      { op: "update_text", uid: "x", text: "onetwo" },
      { op: "delete", uid: "y" },
    ]);
    expect(r.focus).toEqual({ uid: "x", cursor: 3 });
  });

  test("empty block after a structured sibling: deleted, focus on last visible descendant", () => {
    const base = tree();
    // d sits between b (has children) and c
    const t = [base[0], base[1], block("d", "", { order_idx: 6 }), base[2]];
    const r = backspaceAtStart(t, P, uid("d"));
    expect(r.ops).toEqual([{ op: "delete", uid: "d" }]);
    expect(r.focus).toEqual({ uid: "b2", cursor: 5 }); // "b-two".length
  });

  test("no-ops: non-empty first sibling, block with children, non-empty after structured prev", () => {
    expect(backspaceAtStart(tree(), P, uid("a")).ops).toEqual([]);
    expect(backspaceAtStart(tree(), P, uid("b1")).ops).toEqual([]); // first child, has text
    expect(backspaceAtStart(tree(), P, uid("b")).ops).toEqual([]);  // has children
    const t = [tree()[1], block("d", "text", { order_idx: 6 })];
    expect(backspaceAtStart(t, P, uid("d")).ops).toEqual([]); // prev structured, not empty
  });

  test("empty first child: deleted, focus lands on the parent", () => {
    const t = [block("p", "parent", { order_idx: 0, children: [
      block("k", "", { order_idx: 0 }),
      block("k2", "sibling", { order_idx: 1 }),
    ] })];
    const r = backspaceAtStart(t, P, uid("k"));
    expect(r.ops).toEqual([{ op: "delete", uid: "k" }]);
    expect(r.focus).toEqual({ uid: "p", cursor: 6 }); // "parent".length
    expect(findNode(r.blocks, uid("k"))).toBeNull();
  });

  test("empty first top-level block: deleted, focus lands on the next block", () => {
    const t = [block("x", "", { order_idx: 0 }),
               block("y", "two", { order_idx: 1 })];
    const r = backspaceAtStart(t, P, uid("x"));
    expect(r.ops).toEqual([{ op: "delete", uid: "x" }]);
    expect(r.focus).toEqual({ uid: "y", cursor: 0 });
  });

  test("sole empty block on the page: deleted, focus cleared", () => {
    const t = [block("x", "", { order_idx: 0 })];
    const r = backspaceAtStart(t, P, uid("x"));
    expect(r.ops).toEqual([{ op: "delete", uid: "x" }]);
    expect(r.focus).toBeNull();
    expect(r.blocks).toEqual([]);
  });
});

describe("setCollapsed", () => {
  test("emits the op and applies it", () => {
    const r = setCollapsed(tree(), P, uid("b"), true);
    expect(r.ops).toEqual([{ op: "set_collapsed", uid: "b", collapsed: true }]);
    expect(findNode(r.blocks, uid("b"))!.collapsed).toBe(true);
  });
});

describe("setHeading", () => {
  test("emits the op and applies it", () => {
    const r = setHeading(tree(), P, uid("b"), 2);
    expect(r.ops).toEqual([{ op: "set_heading", uid: "b", heading: 2 }]);
    expect(findNode(r.blocks, uid("b"))!.heading).toBe(2);
  });

  test("clearing back to plain text", () => {
    const r = setHeading(tree(), P, uid("b"), null);
    expect(r.ops).toEqual([{ op: "set_heading", uid: "b", heading: null }]);
    expect(findNode(r.blocks, uid("b"))!.heading).toBeNull();
  });

  test("no-op for an unknown uid", () => {
    expect(setHeading(tree(), P, uid("ghost"), 1).ops).toEqual([]);
  });
});

describe("setViewType", () => {
  test("emits one op and applies it optimistically", () => {
    const r = setViewType(tree(), P, uid("b"), "numbered");
    expect(r.ops).toEqual([
      { op: "set_view_type", uid: "b", view_type: "numbered" },
    ]);
    expect(findNode(r.blocks, uid("b"))!.view_type).toBe("numbered");
    expect(findNode(r.blocks, uid("b"))!.text).toBe("beta");
  });

  test("explicit document mode and unknown-uid no-op", () => {
    const r = setViewType(tree(), P, uid("b"), "document");
    expect(findNode(r.blocks, uid("b"))!.view_type).toBe("document");
    expect(setViewType(tree(), P, uid("ghost"), "numbered").ops).toEqual([]);
  });
});
