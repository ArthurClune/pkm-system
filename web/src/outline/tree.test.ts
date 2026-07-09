import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import { block } from "../test-helpers";
import { applyOps, findNode, insertSubtree, locate, removeSubtree, visibleNeighbor, visibleUids } from "./tree";

// Siblings with order_idx GAPS (0, 5, 7) — the server leaves gaps after
// shifts; every helper must key on order_idx values, never array positions.
const tree = () => [
  block("a", "A", { order_idx: 0 }),
  block("b", "B", {
    order_idx: 5,
    children: [
      block("b1", "B1", { order_idx: 0 }),
      block("b2", "B2", { order_idx: 3 }),
    ],
  }),
  block("c", "C", { order_idx: 7, collapsed: true,
                    children: [block("c1", "C1", { order_idx: 0 })] }),
];

describe("locate / visibility", () => {
  test("locate finds nested nodes with parent and index", () => {
    const found = locate(tree(), "b2")!;
    expect(found.node.uid).toBe("b2");
    expect(found.parent?.uid).toBe("b");
    expect(found.index).toBe(1);
    expect(found.siblings.map((s) => s.uid)).toEqual(["b1", "b2"]);
    expect(locate(tree(), "nope")).toBeNull();
  });

  test("visibleUids skips children of collapsed blocks", () => {
    expect(visibleUids(tree())).toEqual(["a", "b", "b1", "b2", "c"]);
  });

  test("visibleNeighbor walks the on-screen order", () => {
    expect(visibleNeighbor(tree(), "b2", "down")).toBe("c");
    expect(visibleNeighbor(tree(), "b", "up")).toBe("a");
    expect(visibleNeighbor(tree(), "a", "up")).toBeNull();
    expect(visibleNeighbor(tree(), "c", "down")).toBeNull();
  });
});

describe("applyOps mirrors ops_apply.py", () => {
  test("create shifts later siblings and inserts sorted", () => {
    const op: BlockOp = { op: "create", uid: "n1", page_title: "P",
                          parent_uid: null, order_idx: 5, text: "new" };
    const out = applyOps(tree(), [op], "P");
    expect(out.map((n) => [n.uid, n.order_idx])).toEqual(
      [["a", 0], ["n1", 5], ["b", 6], ["c", 8]]);
  });

  test("create for another page is skipped", () => {
    const op: BlockOp = { op: "create", uid: "n1", page_title: "Other",
                          parent_uid: null, order_idx: 0, text: "x" };
    expect(applyOps(tree(), [op], "P").map((n) => n.uid)).toEqual(["a", "b", "c"]);
  });

  test("move follows insert-before-pre-removal semantics ([A,B,C] A->2 = [B,A,C])", () => {
    const abc = [block("a", "A", { order_idx: 0 }),
                 block("b", "B", { order_idx: 1 }),
                 block("c", "C", { order_idx: 2 })];
    const op: BlockOp = { op: "move", uid: "a", parent_uid: null, order_idx: 2 };
    const out = applyOps(abc, [op], "P");
    expect(out.map((n) => n.uid)).toEqual(["b", "a", "c"]);
    expect(out.map((n) => n.order_idx)).toEqual([1, 2, 3]);
  });

  test("move reparents into a nested target", () => {
    const op: BlockOp = { op: "move", uid: "a", parent_uid: "b", order_idx: 3 };
    const out = applyOps(tree(), [op], "P");
    expect(out.map((n) => n.uid)).toEqual(["b", "c"]);
    expect(findNode(out, "b")!.children.map((n) => [n.uid, n.order_idx]))
      .toEqual([["b1", 0], ["a", 3], ["b2", 4]]);
  });

  test("delete removes the whole subtree; update_text and set_collapsed hit the node", () => {
    const out = applyOps(tree(), [
      { op: "delete", uid: "b" },
      { op: "update_text", uid: "a", text: "A!" },
      { op: "set_collapsed", uid: "c", collapsed: false },
    ], "P");
    expect(out.map((n) => n.uid)).toEqual(["a", "c"]);
    expect(findNode(out, "a")!.text).toBe("A!");
    expect(findNode(out, "c")!.collapsed).toBe(false);
    expect(findNode(out, "b1")).toBeNull();
  });

  test("ops for uids not in this tree (other pages on the ws) are skipped", () => {
    const out = applyOps(tree(), [
      { op: "update_text", uid: "zz", text: "x" },
      { op: "delete", uid: "zz" },
      { op: "move", uid: "zz", parent_uid: null, order_idx: 0 },
      { op: "set_collapsed", uid: "zz", collapsed: true },
    ], "P");
    expect(out.map((n) => n.uid)).toEqual(["a", "b", "c"]);
  });

  test("does not mutate its input", () => {
    const input = tree();
    applyOps(input, [{ op: "update_text", uid: "a", text: "changed" }], "P");
    expect(input[0].text).toBe("A");
  });

  test("applyOps removes the subtree when a move targets another page", () => {
    const tree = [block("a", "A"), { ...block("b", "B"), children: [block("c", "C")] }];
    const next = applyOps(tree, [
      { op: "move", uid: "b", parent_uid: null, order_idx: 0,
        page_title: "Elsewhere" }], "Here");
    expect(next.map((n) => n.uid)).toEqual(["a"]);
  });

  test("applyOps still applies a move whose page_title names this page", () => {
    const tree = [block("a", "A", { order_idx: 0 }), block("b", "B", { order_idx: 1 })];
    const next = applyOps(tree, [
      { op: "move", uid: "b", parent_uid: null, order_idx: 0,
        page_title: "Here" }], "Here");
    expect(next.map((n) => n.uid)).toEqual(["b", "a"]);
  });

  test("removeSubtree detaches a nested subtree and returns it", () => {
    const tree = [{ ...block("a", "A"), children: [
      { ...block("b", "B"), children: [block("c", "C")] }] }];
    const { tree: next, node } = removeSubtree(tree, "b");
    expect(node?.uid).toBe("b");
    expect(node?.children.map((n) => n.uid)).toEqual(["c"]);
    expect(next[0].children).toEqual([]);
    expect(tree[0].children.length).toBe(1); // input not mutated
  });

  test("insertSubtree inserts before the sibling at order_idx", () => {
    const tree = [block("x", "X", { order_idx: 0 }), block("y", "Y", { order_idx: 1 })];
    const node = block("n", "N");
    const next = insertSubtree(tree, node, null, 1);
    expect(next.map((n) => n.uid)).toEqual(["x", "n", "y"]);
  });
});
