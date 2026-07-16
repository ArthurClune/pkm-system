import { describe, expect, test } from "vitest";
import { block } from "../test-helpers";
import { findNode } from "./tree";
import { backspaceAtStart, clampCaret, deleteSelection, indentBlock,
         moveBlockDown, moveBlocksTo, moveBlockUp, moveSelectionDown,
         moveSelectionUp, moveSubtreeDown, moveSubtreeUp, outdentBlock,
         setCollapsed, setHeading, setViewType, splitBlock } from "./edits";

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

describe("moveSelectionUp / moveSelectionDown (pkm-q89w)", () => {
  test("up: the run [b, c] swaps past the sibling above (a moves after c)", () => {
    const r = moveSelectionUp(tree(), P, ["b", "c"]);
    expect(r.ops).toEqual([
      { op: "move", uid: "a", parent_uid: null, order_idx: 8 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "c", "a"]);
    // the moved run keeps its own relative order and doesn't move itself
    expect(r.blocks[0].uid).toBe("b");
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1", "b2"]);
  });

  test("down: the run [a, b] swaps past the sibling below (c moves before a)", () => {
    const r = moveSelectionDown(tree(), P, ["a", "b"]);
    expect(r.ops).toEqual([
      { op: "move", uid: "c", parent_uid: null, order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["c", "a", "b"]);
  });

  test("a run already at the top/bottom edge is a no-op", () => {
    expect(moveSelectionUp(tree(), P, ["a", "b"]).ops).toEqual([]);
    expect(moveSelectionDown(tree(), P, ["b", "c"]).ops).toEqual([]);
  });

  test("uids that aren't a contiguous sibling run are a no-op", () => {
    // "a" is top-level, "b1" is b's child: different parents.
    expect(moveSelectionUp(tree(), P, ["a", "b1"]).ops).toEqual([]);
    expect(moveSelectionDown(tree(), P, ["a", "b1"]).ops).toEqual([]);
  });

  test("empty selection is a no-op", () => {
    expect(moveSelectionUp(tree(), P, []).ops).toEqual([]);
    expect(moveSelectionDown(tree(), P, []).ops).toEqual([]);
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
