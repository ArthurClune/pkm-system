import { describe, expect, test } from "vitest";
import { block } from "../test-helpers";
import { findNode } from "./tree";
import { backspaceAtStart, indentBlock, moveBlockDown, moveBlockUp,
         outdentBlock, setCollapsed, setHeading, splitBlock } from "./edits";

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

  test("no-ops: first sibling, block with children, non-empty after structured prev", () => {
    expect(backspaceAtStart(tree(), P, "a").ops).toEqual([]);
    expect(backspaceAtStart(tree(), P, "b1").ops).toEqual([]); // first child
    expect(backspaceAtStart(tree(), P, "b").ops).toEqual([]);  // has children
    const t = [tree()[1], block("d", "text", { order_idx: 6 })];
    expect(backspaceAtStart(t, P, "d").ops).toEqual([]); // prev structured, not empty
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
