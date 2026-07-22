import { describe, expect, test } from "vitest";
import { block } from "../test-helpers";
import { findNode } from "./tree";
import { backspaceAtStart, clampCaret, deleteSelection, indentBlock,
         indentSelection, moveBlockDown, moveBlocksTo, moveBlockUp,
         moveSelectionDown, moveSelectionUp, moveSubtreeDown, moveSubtreeUp,
         outdentBlock, outdentSelection, setCollapsed, setHeading,
         setViewType, splitBlock } from "./edits";

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

const P = "Page";
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

describe("splitBlock", () => {
  test("mid-text: keeps head in place, tail becomes the next sibling, focus on new", () => {
    const r = splitBlock(tree(), P, "a", 2, "new111");
    expect(r.ops).toEqual([
      { op: "update_text", uid: "a", text: "al" },
      { op: "create", uid: "new111", page_title: P, parent_uid: null,
        order_idx: 5, text: "pha" }, // before b (order 5), server shifts b,c
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "new111", "b", "c"]);
    expect(r.focus).toEqual({ uid: "new111", cursor: 0 });
  });

  test("at end of a childless block: plain empty sibling, no update_text", () => {
    const r = splitBlock(tree(), P, "c", 5, "new111");
    expect(r.ops).toEqual([
      { op: "create", uid: "new111", page_title: P, parent_uid: null,
        order_idx: 8, text: "" },
    ]);
    expect(r.focus).toEqual({ uid: "new111", cursor: 0 });
  });

  test("at cursor 0 with text: empty block inserted ABOVE, uid keeps its text", () => {
    const r = splitBlock(tree(), P, "a", 0, "new111");
    expect(r.ops).toEqual([
      { op: "create", uid: "new111", page_title: P, parent_uid: null,
        order_idx: 0, text: "" },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["new111", "a", "b", "c"]);
    expect(r.focus).toEqual({ uid: "a", cursor: 0 });
  });

  test("on an expanded block with children: new block becomes first child", () => {
    const r = splitBlock(tree(), P, "b", 4, "new111");
    expect(r.ops).toEqual([
      { op: "create", uid: "new111", page_title: P, parent_uid: "b",
        order_idx: 0, text: "" },
    ]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["new111", "b1", "b2"]);
  });

  test("unknown uid is a no-op", () => {
    const r = splitBlock(tree(), P, "zz", 0, "new111");
    expect(r.ops).toEqual([]);
  });
});

describe("indent / outdent", () => {
  test("indent moves under previous sibling, after its last child", () => {
    const r = indentBlock(tree(), P, "c");
    expect(r.ops).toEqual([
      { op: "move", uid: "c", parent_uid: "b", order_idx: 4 }, // b2 is 3
    ]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1", "b2", "c"]);
  });

  test("indent expands a collapsed new parent first", () => {
    const t = tree();
    findNode(t, "b")!.collapsed = true;
    const r = indentBlock(t, P, "c");
    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "b", collapsed: false },
      { op: "move", uid: "c", parent_uid: "b", order_idx: 4 },
    ]);
  });

  test("first sibling can't indent", () => {
    expect(indentBlock(tree(), P, "a").ops).toEqual([]);
    expect(indentBlock(tree(), P, "b1").ops).toEqual([]);
  });

  test("outdent becomes the sibling right after its old parent", () => {
    const r = outdentBlock(tree(), P, "b1");
    expect(r.ops).toEqual([
      { op: "move", uid: "b1", parent_uid: null, order_idx: 7 }, // before c
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "b", "b1", "c"]);
  });

  test("top-level blocks can't outdent", () => {
    expect(outdentBlock(tree(), P, "a").ops).toEqual([]);
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

describe("indentSelection / outdentSelection (pkm-0ovd)", () => {
  test("indents one sibling run under one parent without staircasing", () => {
    const r = indentSelection(selectionTree(), P, ["b", "b1", "c"]);

    expect(r.ops).toEqual([
      { op: "move", uid: "b", parent_uid: "a", order_idx: 2 },
      { op: "move", uid: "c", parent_uid: "a", order_idx: 3 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a"]);
    expect(findNode(r.blocks, "a")!.children.map((n) => n.uid))
      .toEqual(["a0", "a1", "b", "c"]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1"]);
  });

  test("indents mixed-level roots from original destinations by one level", () => {
    const r = indentSelection(selectionTree(), P, ["a1", "a1x", "b", "b1"]);

    expect(r.ops).toEqual([
      { op: "move", uid: "a1", parent_uid: "a0", order_idx: 0 },
      { op: "move", uid: "b", parent_uid: "a", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, "a0")!.children.map((n) => n.uid))
      .toEqual(["a1"]);
    expect(findNode(r.blocks, "a1")!.children.map((n) => n.uid))
      .toEqual(["a1x"]);
    expect(findNode(r.blocks, "a")!.children.map((n) => n.uid))
      .toEqual(["a0", "b"]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1"]);
  });

  test("expands a collapsed destination once before moving its run", () => {
    const t = selectionTree();
    findNode(t, "a")!.collapsed = true;

    const r = indentSelection(t, P, ["b", "b1", "c"]);

    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "a", collapsed: false },
      { op: "move", uid: "b", parent_uid: "a", order_idx: 2 },
      { op: "move", uid: "c", parent_uid: "a", order_idx: 3 },
    ]);
  });

  test("one first-sibling run aborts every indent run", () => {
    const t = selectionTree();
    const r = indentSelection(
      t, P, ["a0", "a1", "a1x", "b", "b1"],
    );

    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });

  test("outdents one sibling run consecutively after its former parent", () => {
    const r = outdentSelection(selectionTree(), P, ["a0", "a1", "a1x"]);

    expect(r.ops).toEqual([
      { op: "move", uid: "a0", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "a1", parent_uid: null, order_idx: 2 },
    ]);
    expect(r.blocks.map((n) => n.uid))
      .toEqual(["a", "a0", "a1", "b", "c"]);
    expect(findNode(r.blocks, "a1")!.children.map((n) => n.uid))
      .toEqual(["a1x"]);
  });

  test("outdents mixed-level roots once while preserving their subtrees", () => {
    const r = outdentSelection(
      mixedOutdentTree(), P, ["x", "q", "q1"],
    );

    expect(r.ops).toEqual([
      { op: "move", uid: "x", parent_uid: "root", order_idx: 1 },
      { op: "move", uid: "q", parent_uid: null, order_idx: 1 },
    ]);
    expect(findNode(r.blocks, "root")!.children.map((n) => n.uid))
      .toEqual(["p", "x"]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["root", "q", "z"]);
    expect(findNode(r.blocks, "q")!.children.map((n) => n.uid))
      .toEqual(["q1"]);
  });

  test("one top-level root aborts every outdent run", () => {
    const t = selectionTree();
    const r = outdentSelection(t, P, ["a1", "a1x", "b", "b1"]);

    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });

  test("empty or missing selections are no-ops", () => {
    const t = selectionTree();
    expect(indentSelection(t, P, []).ops).toEqual([]);
    expect(outdentSelection(t, P, []).ops).toEqual([]);
    expect(indentSelection(t, P, ["missing"]).ops).toEqual([]);
    expect(outdentSelection(t, P, ["missing"]).ops).toEqual([]);
  });
});

describe("moveBlockUp / moveBlockDown", () => {
  test("up swaps with previous sibling (insert before it)", () => {
    const r = moveBlockUp(tree(), P, "b2");
    expect(r.ops).toEqual([
      { op: "move", uid: "b2", parent_uid: "b", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b2", "b1"]);
  });

  test("down inserts before the block after next ([a,b,c]: a -> before c)", () => {
    const r = moveBlockDown(tree(), P, "a");
    expect(r.ops).toEqual([
      { op: "move", uid: "a", parent_uid: null, order_idx: 7 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "a", "c"]);
  });

  test("down from the second-to-last lands last", () => {
    const r = moveBlockDown(tree(), P, "b");
    expect(r.ops).toEqual([
      { op: "move", uid: "b", parent_uid: null, order_idx: 8 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "c", "b"]);
  });

  test("edges are no-ops", () => {
    expect(moveBlockUp(tree(), P, "a").ops).toEqual([]);
    expect(moveBlockDown(tree(), P, "c").ops).toEqual([]);
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

describe("moveSubtreeUp / moveSubtreeDown (pkm-hx2w)", () => {
  test("up: a previous sibling means a plain sibling swap", () => {
    const r = moveSubtreeUp(deepTree(), P, "b2");
    expect(r.ops).toEqual([
      { op: "move", uid: "b2", parent_uid: "b", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b2", "b1"]);
  });

  test("up: no previous sibling, parent has one — becomes its last child", () => {
    const r = moveSubtreeUp(deepTree(), P, "b1");
    expect(r.ops).toEqual([
      { op: "move", uid: "b1", parent_uid: "a", order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "b", "c"]);
    expect(findNode(r.blocks, "a")!.children.map((n) => n.uid)).toEqual(["b1"]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid)).toEqual(["b2"]);
    // subtree carried intact: b1's own child comes along
    expect(findNode(r.blocks, "b1")!.children.map((n) => n.uid)).toEqual(["b1x"]);
  });

  test("up: top-level block with no previous sibling is a no-op", () => {
    const r = moveSubtreeUp(deepTree(), P, "a");
    expect(r.ops).toEqual([]);
    expect(r.blocks).toEqual(deepTree());
  });

  test("up: level-3 block whose parent has no previous sibling is a no-op " +
       "(escaping further would make it level 1)", () => {
    const r = moveSubtreeUp(deepTree(), P, "b1x");
    expect(r.ops).toEqual([]);
    expect(r.blocks).toEqual(deepTree());
  });

  test("down: a next sibling means a plain sibling swap", () => {
    const r = moveSubtreeDown(deepTree(), P, "b1");
    expect(r.ops).toEqual([
      { op: "move", uid: "b1", parent_uid: "b", order_idx: 4 },
    ]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b2", "b1"]);
    expect(findNode(r.blocks, "b1")!.children.map((n) => n.uid)).toEqual(["b1x"]);
  });

  test("down: no next sibling, parent has one — becomes its first child", () => {
    const r = moveSubtreeDown(deepTree(), P, "b2");
    expect(r.ops).toEqual([
      { op: "move", uid: "b2", parent_uid: "c", order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "b", "c"]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid)).toEqual(["b1"]);
    expect(findNode(r.blocks, "c")!.children.map((n) => n.uid)).toEqual(["b2"]);
  });

  test("down: top-level block with no next sibling is a no-op", () => {
    const r = moveSubtreeDown(deepTree(), P, "c");
    expect(r.ops).toEqual([]);
    expect(r.blocks).toEqual(deepTree());
  });

  test("down: level-3 block whose parent has no next sibling escape is not " +
       "a no-op here — the parent DOES have one, so it becomes b2's first " +
       "child, still depth-preserving", () => {
    const r = moveSubtreeDown(deepTree(), P, "b1x");
    expect(r.ops).toEqual([
      { op: "move", uid: "b1x", parent_uid: "b2", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, "b1")!.children).toEqual([]);
    expect(findNode(r.blocks, "b2")!.children.map((n) => n.uid)).toEqual(["b1x"]);
  });

  test("up: a collapsed destination P is expanded — otherwise the moved " +
       "block would be hidden and lose focus", () => {
    const t = deepTree();
    findNode(t, "a")!.collapsed = true;
    const r = moveSubtreeUp(t, P, "b1");
    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "a", collapsed: false },
      { op: "move", uid: "b1", parent_uid: "a", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, "a")!.collapsed).toBe(false);
    expect(findNode(r.blocks, "a")!.children.map((n) => n.uid)).toEqual(["b1"]);
  });

  test("down: a collapsed destination N is expanded — otherwise the moved " +
       "block would be hidden and lose focus", () => {
    const t = deepTree();
    findNode(t, "c")!.collapsed = true;
    const r = moveSubtreeDown(t, P, "b2");
    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "c", collapsed: false },
      { op: "move", uid: "b2", parent_uid: "c", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, "c")!.collapsed).toBe(false);
    expect(findNode(r.blocks, "c")!.children.map((n) => n.uid)).toEqual(["b2"]);
  });

  test("up: destination P already has children — the block simply joins as " +
       "the new last", () => {
    const t = deepTree();
    findNode(t, "a")!.children.push(block("ax", "a-ex", { order_idx: 0 }));
    const r = moveSubtreeUp(t, P, "b1");
    expect(r.ops).toEqual([
      { op: "move", uid: "b1", parent_uid: "a", order_idx: 1 },
    ]);
    expect(findNode(r.blocks, "a")!.children.map((n) => n.uid)).toEqual(["ax", "b1"]);
  });

  test("down: destination N already has children — the block lands FIRST, " +
       "existing children shift (shiftFrom path)", () => {
    const t = deepTree();
    findNode(t, "c")!.children.push(block("cx", "c-ex", { order_idx: 0 }));
    const r = moveSubtreeDown(t, P, "b2");
    expect(r.ops).toEqual([
      { op: "move", uid: "b2", parent_uid: "c", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, "c")!.children.map((n) => n.uid)).toEqual(["b2", "cx"]);
  });

  test("unknown uid is a no-op", () => {
    expect(moveSubtreeUp(deepTree(), P, "zz").ops).toEqual([]);
    expect(moveSubtreeDown(deepTree(), P, "zz").ops).toEqual([]);
  });
});

describe("moveSelectionUp / moveSelectionDown (pkm-8jt5)", () => {
  test("up: a same-parent run swaps with the sibling above", () => {
    const r = moveSelectionUp(tree(), P, ["b", "c"]);
    expect(r.ops).toEqual([
      { op: "move", uid: "a", parent_uid: null, order_idx: 8 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "c", "a"]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1", "b2"]);
  });

  test("down: a same-parent run swaps with the sibling below", () => {
    const r = moveSelectionDown(tree(), P, ["a", "b"]);
    expect(r.ops).toEqual([
      { op: "move", uid: "c", parent_uid: null, order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["c", "a", "b"]);
  });

  test("up: an edge run becomes the previous parent's last children", () => {
    const r = moveSelectionUp(
      selectedMoveTree(), P, ["first", "first0", "second"],
    );

    expect(r.ops).toEqual([
      { op: "move", uid: "first", parent_uid: "left", order_idx: 1 },
      { op: "move", uid: "second", parent_uid: "left", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, "left")!.children.map((n) => n.uid))
      .toEqual(["left0", "first", "second"]);
    expect(findNode(r.blocks, "source")!.children).toEqual([]);
    expect(findNode(r.blocks, "first")!.children.map((n) => n.uid))
      .toEqual(["first0"]);
  });

  test("down: a collapsed root carries hidden descendants without expanding", () => {
    const t = selectedMoveTree();
    findNode(t, "first")!.collapsed = true;

    const r = moveSelectionDown(t, P, ["first", "second"]);

    expect(r.ops).toEqual([
      { op: "move", uid: "first", parent_uid: "right", order_idx: 0 },
      { op: "move", uid: "second", parent_uid: "right", order_idx: 1 },
    ]);
    expect(findNode(r.blocks, "right")!.children.map((n) => n.uid))
      .toEqual(["first", "second", "right0"]);
    expect(findNode(r.blocks, "source")!.children).toEqual([]);
    expect(findNode(r.blocks, "first")!.collapsed).toBe(true);
    expect(findNode(r.blocks, "first")!.children.map((n) => n.uid))
      .toEqual(["first0"]);
  });

  test("up: a collapsed selected destination root stays collapsed", () => {
    const r = moveSelectionUp(selectedDestinationTree(), P, ["b", "c0", "c1"]);

    expect(r.ops).toEqual([
      { op: "move", uid: "a", parent_uid: null, order_idx: 2 },
      { op: "move", uid: "c0", parent_uid: "b", order_idx: 1 },
      { op: "move", uid: "c1", parent_uid: "b", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, "b")!.collapsed).toBe(true);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b0", "c0", "c1"]);
  });

  test("moves eligible mixed-depth runs from original positions", () => {
    const r = moveSelectionUp(selectionTree(), P, ["a1", "b"]);

    expect(r.ops).toEqual([
      { op: "move", uid: "a0", parent_uid: "a", order_idx: 2 },
      { op: "move", uid: "a", parent_uid: null, order_idx: 2 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "a", "c"]);
    expect(findNode(r.blocks, "a")!.children.map((n) => n.uid))
      .toEqual(["a1", "a0"]);
    expect(findNode(r.blocks, "a1")!.children.map((n) => n.uid))
      .toEqual(["a1x"]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1"]);
  });

  test("one ineligible run aborts every mixed-depth run", () => {
    const t = selectionTree();
    const r = moveSelectionUp(t, P, ["a0", "b"]);

    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });

  test("expands a collapsed cross-parent destination before its moves", () => {
    const t = selectedMoveTree();
    findNode(t, "left")!.collapsed = true;

    const r = moveSelectionUp(t, P, ["first", "second"]);

    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "left", collapsed: false },
      { op: "move", uid: "first", parent_uid: "left", order_idx: 1 },
      { op: "move", uid: "second", parent_uid: "left", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, "left")!.collapsed).toBe(false);
  });

  test("empty and unknown selections are no-ops", () => {
    const t = selectedMoveTree();
    expect(moveSelectionUp(t, P, []).ops).toEqual([]);
    expect(moveSelectionDown(t, P, []).ops).toEqual([]);
    expect(moveSelectionUp(t, P, ["missing"]).ops).toEqual([]);
    expect(moveSelectionDown(t, P, ["missing"]).ops).toEqual([]);
  });
});

describe("moveBlocksTo (pkm-q89w drag)", () => {
  test("moves every uid to the target as a contiguous run, order preserved", () => {
    // drop [b, c] at the very top: one move op per block, sequential slots
    const r = moveBlocksTo(tree(), P, ["b", "c"], null, 0);
    expect(r.ops).toEqual([
      { op: "move", uid: "b", parent_uid: null, order_idx: 0 },
      { op: "move", uid: "c", parent_uid: null, order_idx: 1 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "c", "a"]);
    // b keeps its subtree through the move
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1", "b2"]);
  });

  test("reparents a cross-parent root run, order preserved", () => {
    // b's children dragged out to the top level
    const r = moveBlocksTo(tree(), P, ["b1", "b2"], null, 0);
    expect(r.ops).toEqual([
      { op: "move", uid: "b1", parent_uid: null, order_idx: 0 },
      { op: "move", uid: "b2", parent_uid: null, order_idx: 1 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b1", "b2", "a", "b", "c"]);
    expect(findNode(r.blocks, "b")!.children).toEqual([]);
  });

  test("a selected parent + its child moves only the parent (subtree comes along)", () => {
    const r = moveBlocksTo(tree(), P, ["b", "b1"], null, 0);
    expect(r.ops).toEqual([
      { op: "move", uid: "b", parent_uid: null, order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "a", "c"]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1", "b2"]);
  });

  test("moving into a new parent block", () => {
    const r = moveBlocksTo(tree(), P, ["a", "c"], "b", 4); // after b2 (idx 3)
    expect(r.ops).toEqual([
      { op: "move", uid: "a", parent_uid: "b", order_idx: 4 },
      { op: "move", uid: "c", parent_uid: "b", order_idx: 5 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b"]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1", "b2", "a", "c"]);
  });

  test("empty uids is a no-op", () => {
    expect(moveBlocksTo(tree(), P, [], null, 0).ops).toEqual([]);
  });
});

describe("deleteSelection (pkm-q89w)", () => {
  test("deletes every selected top-level block, focus on the sibling after", () => {
    const r = deleteSelection(tree(), P, ["a", "b"]);
    expect(r.ops).toEqual([
      { op: "delete", uid: "a" },
      { op: "delete", uid: "b" },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["c"]);
    expect(r.focus).toEqual({ uid: "c", cursor: 0 });
  });

  test("a selected parent + its child only emits one delete (child cascades away)", () => {
    const r = deleteSelection(tree(), P, ["b", "b1"]);
    expect(r.ops).toEqual([{ op: "delete", uid: "b" }]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "c"]);
    expect(r.focus).toEqual({ uid: "a", cursor: 5 }); // "alpha".length
  });

  test("focus falls back to the visible block before the run", () => {
    const r = deleteSelection(tree(), P, ["c"]);
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
    const r = backspaceAtStart(t, P, "y");
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
    const r = backspaceAtStart(t, P, "d");
    expect(r.ops).toEqual([{ op: "delete", uid: "d" }]);
    expect(r.focus).toEqual({ uid: "b2", cursor: 5 }); // "b-two".length
  });

  test("no-ops: non-empty first sibling, block with children, non-empty after structured prev", () => {
    expect(backspaceAtStart(tree(), P, "a").ops).toEqual([]);
    expect(backspaceAtStart(tree(), P, "b1").ops).toEqual([]); // first child, has text
    expect(backspaceAtStart(tree(), P, "b").ops).toEqual([]);  // has children
    const t = [tree()[1], block("d", "text", { order_idx: 6 })];
    expect(backspaceAtStart(t, P, "d").ops).toEqual([]); // prev structured, not empty
  });

  test("empty first child: deleted, focus lands on the parent", () => {
    const t = [block("p", "parent", { order_idx: 0, children: [
      block("k", "", { order_idx: 0 }),
      block("k2", "sibling", { order_idx: 1 }),
    ] })];
    const r = backspaceAtStart(t, P, "k");
    expect(r.ops).toEqual([{ op: "delete", uid: "k" }]);
    expect(r.focus).toEqual({ uid: "p", cursor: 6 }); // "parent".length
    expect(findNode(r.blocks, "k")).toBeNull();
  });

  test("empty first top-level block: deleted, focus lands on the next block", () => {
    const t = [block("x", "", { order_idx: 0 }),
               block("y", "two", { order_idx: 1 })];
    const r = backspaceAtStart(t, P, "x");
    expect(r.ops).toEqual([{ op: "delete", uid: "x" }]);
    expect(r.focus).toEqual({ uid: "y", cursor: 0 });
  });

  test("sole empty block on the page: deleted, focus cleared", () => {
    const t = [block("x", "", { order_idx: 0 })];
    const r = backspaceAtStart(t, P, "x");
    expect(r.ops).toEqual([{ op: "delete", uid: "x" }]);
    expect(r.focus).toBeNull();
    expect(r.blocks).toEqual([]);
  });
});

describe("setCollapsed", () => {
  test("emits the op and applies it", () => {
    const r = setCollapsed(tree(), P, "b", true);
    expect(r.ops).toEqual([{ op: "set_collapsed", uid: "b", collapsed: true }]);
    expect(findNode(r.blocks, "b")!.collapsed).toBe(true);
  });
});

describe("setHeading", () => {
  test("emits the op and applies it", () => {
    const r = setHeading(tree(), P, "b", 2);
    expect(r.ops).toEqual([{ op: "set_heading", uid: "b", heading: 2 }]);
    expect(findNode(r.blocks, "b")!.heading).toBe(2);
  });

  test("clearing back to plain text", () => {
    const r = setHeading(tree(), P, "b", null);
    expect(r.ops).toEqual([{ op: "set_heading", uid: "b", heading: null }]);
    expect(findNode(r.blocks, "b")!.heading).toBeNull();
  });

  test("no-op for an unknown uid", () => {
    expect(setHeading(tree(), P, "ghost", 1).ops).toEqual([]);
  });
});

describe("setViewType", () => {
  test("emits one op and applies it optimistically", () => {
    const r = setViewType(tree(), P, "b", "numbered");
    expect(r.ops).toEqual([
      { op: "set_view_type", uid: "b", view_type: "numbered" },
    ]);
    expect(findNode(r.blocks, "b")!.view_type).toBe("numbered");
    expect(findNode(r.blocks, "b")!.text).toBe("beta");
  });

  test("explicit document mode and unknown-uid no-op", () => {
    const r = setViewType(tree(), P, "b", "document");
    expect(findNode(r.blocks, "b")!.view_type).toBe("document");
    expect(setViewType(tree(), P, "ghost", "numbered").ops).toEqual([]);
  });
});
