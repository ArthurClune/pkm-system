import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { block } from "../test-helpers";
import { ancestorChain, applyOps, applyOpsWithChange, blocksEqual, findNode,
         insertSubtree, locate, removeSubtree, visibleNeighbor,
         visibleUids } from "./tree";

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
                          parent_uid: null, order_idx: 5, text: "new",
                          view_type: "numbered" };
    const out = applyOps(tree(), [op], "P");
    expect(out.map((n) => [n.uid, n.order_idx])).toEqual(
      [["a", 0], ["n1", 5], ["b", 6], ["c", 8]]);
    expect(findNode(out, "n1")!.view_type).toBe("numbered");
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

  test("set_heading sets or clears the node's heading (applies to remote batches too)", () => {
    const out = applyOps(tree(), [
      { op: "set_heading", uid: "a", heading: 2 },
    ], "P");
    expect(findNode(out, "a")!.heading).toBe(2);
    const cleared = applyOps(out, [
      { op: "set_heading", uid: "a", heading: null },
    ], "P");
    expect(findNode(cleared, "a")!.heading).toBeNull();
  });

  test("set_view_type updates only persistent presentation metadata", () => {
    const before = tree();
    const out = applyOps(before, [
      { op: "set_view_type", uid: "b", view_type: "numbered" },
    ], "P");
    expect(findNode(out, "b")!.view_type).toBe("numbered");
    expect(findNode(out, "b")!.text).toBe(findNode(before, "b")!.text);
    expect(findNode(out, "b")!.collapsed).toBe(findNode(before, "b")!.collapsed);
    expect(findNode(out, "b")!.children.map((n) => n.uid))
      .toEqual(findNode(before, "b")!.children.map((n) => n.uid));
  });

  test("ops for uids not in this tree (other pages on the ws) are skipped", () => {
    const out = applyOps(tree(), [
      { op: "update_text", uid: "zz", text: "x" },
      { op: "delete", uid: "zz" },
      { op: "move", uid: "zz", parent_uid: null, order_idx: 0 },
      { op: "set_collapsed", uid: "zz", collapsed: true },
      { op: "set_heading", uid: "zz", heading: 1 },
      { op: "set_view_type", uid: "zz", view_type: "numbered" },
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

  test("insertSubtree returns the tree unchanged for an unknown parentUid", () => {
    const before = tree();
    const next = insertSubtree(before, block("n", "N"), "nope", 0);
    expect(next).toEqual(before);      // value-equal (a fresh clone)
    expect(findNode(next, "n")).toBeNull();
  });

  test("insertSubtree inserts under a nested (non-null) parent", () => {
    // b has children b1(0), b2(3); insert at order_idx 3 → before b2, which
    // shifts up. Positions key on order_idx, never array index.
    const next = insertSubtree(tree(), block("n", "N"), "b", 3);
    const parent = findNode(next, "b")!;
    expect(parent.children.map((c) => c.uid)).toEqual(["b1", "n", "b2"]);
    expect(parent.children.map((c) => c.order_idx)).toEqual([0, 3, 4]);
  });

  test("insertSubtree deep-clones the inserted node's children", () => {
    const tree = [block("x", "X", { order_idx: 0 }), block("y", "Y", { order_idx: 1 })];
    const node = { ...block("n", "N"), children: [block("c1", "C1")] };
    const next = insertSubtree(tree, node, null, 1);
    // Mutate the original node's children
    node.children.push(block("c2", "C2"));
    // The returned tree should still have only the original child
    const insertedNode = findNode(next, "n")!;
    expect(insertedNode.children.length).toBe(1);
    expect(insertedNode.children[0].uid).toBe("c1");
  });
});

describe("ancestorChain", () => {
  test("returns the path from the outermost ancestor down to the uid", () => {
    expect(ancestorChain(tree(), "b2")).toEqual(["b", "b2"]);
    expect(ancestorChain(tree(), "a")).toEqual(["a"]);
  });

  test("pops branches it abandoned, so no unrelated ancestor is reported", () => {
    // c1 sits under c; a DFS that forgot to pop would prefix a and b.
    expect(ancestorChain(tree(), "c1")).toEqual(["c", "c1"]);
  });

  test("returns nothing for a uid this tree does not hold", () => {
    expect(ancestorChain(tree(), "zz")).toEqual([]);
  });
});

describe("blocksEqual", () => {
  test("holds for separate clones of the same tree and for one array twice", () => {
    const same = tree();
    expect(blocksEqual(same, same)).toBe(true);
    expect(blocksEqual(tree(), tree())).toBe(true);
  });

  test("fails on sibling count and on sibling order", () => {
    const a = [block("x", "X", { order_idx: 0 }),
               block("y", "Y", { order_idx: 1 })];
    expect(blocksEqual(a, [a[0]])).toBe(false);
    expect(blocksEqual(a, [a[1], a[0]])).toBe(false);
  });

  test("fails on a difference in any BlockNode field", () => {
    // A field this compare forgets would be a silently missed change, so the
    // sweep is over the node's real keys: a new payload field fails here.
    const base = block("u1", "text", {
      heading: 2, view_type: "numbered", collapsed: true, order_idx: 3,
      created_at: 1, updated_at: 2, children: [block("kid", "K")],
    });
    for (const field of Object.keys(base)) {
      const value = base[field as keyof BlockNode];
      const other = typeof value === "string" ? `${value}!`
        : typeof value === "number" ? value + 1
        : typeof value === "boolean" ? !value
        : [];
      expect(blocksEqual([base], [{ ...base, [field]: other } as BlockNode]),
             `blocksEqual ignored ${field}`).toBe(false);
    }
  });
});

describe("applyOpsWithChange reports exactly what a serialize-compare would", () => {
  // The change flag replaced a JSON.stringify compare of the whole tree in
  // outlineState, so the flag is asserted against that very compare: a no-op
  // op reported as a change would re-render (and bump the revision) for
  // nothing, and a real change reported as none would strand the edit.
  const cases: [string, BlockOp][] = [
    ["a create for this page", { op: "create", uid: "n1", page_title: "P",
                                 parent_uid: null, order_idx: 5, text: "new" }],
    ["a create for another page", { op: "create", uid: "n1",
                                    page_title: "Other", parent_uid: null,
                                    order_idx: 0, text: "new" }],
    ["a create replaying a uid already here", {
      op: "create", uid: "b", page_title: "P", parent_uid: null,
      order_idx: 5, text: "B" }],
    ["a create under a parent this tree does not hold", {
      op: "create", uid: "n1", page_title: "P", parent_uid: "zz",
      order_idx: 0, text: "new" }],
    ["a page creation", { op: "create_page", page_title: "Other" }],
    ["update_text to a different text", {
      op: "update_text", uid: "a", text: "A!" }],
    ["update_text to the text already there", {
      op: "update_text", uid: "a", text: "A" }],
    ["set_collapsed flipping the flag", {
      op: "set_collapsed", uid: "a", collapsed: true }],
    ["set_collapsed to the value already there", {
      op: "set_collapsed", uid: "a", collapsed: false }],
    ["set_heading to a heading", { op: "set_heading", uid: "a", heading: 2 }],
    ["set_heading clearing an already-absent heading", {
      op: "set_heading", uid: "a", heading: null }],
    ["set_view_type to a view", {
      op: "set_view_type", uid: "a", view_type: "numbered" }],
    ["a delete", { op: "delete", uid: "b" }],
    ["a delete of a uid not here", { op: "delete", uid: "zz" }],
    ["a move that shifts a later sibling", {
      op: "move", uid: "a", parent_uid: null, order_idx: 5 }],
    ["a move that lands a top-level block back where it was", {
      op: "move", uid: "c", parent_uid: null, order_idx: 7 }],
    ["a move that lands a nested block back where it was", {
      op: "move", uid: "b2", parent_uid: "b", order_idx: 3 }],
    ["a move that reparents", {
      op: "move", uid: "a", parent_uid: "b", order_idx: 3 }],
    ["a move whose page_title names another page", {
      op: "move", uid: "b", parent_uid: null, order_idx: 0,
      page_title: "Elsewhere" }],
    ["a move under a parent this tree does not hold", {
      op: "move", uid: "a", parent_uid: "zz", order_idx: 0 }],
    ["a move of a uid not here", {
      op: "move", uid: "zz", parent_uid: null, order_idx: 0 }],
  ];

  for (const [name, op] of cases) {
    test(name, () => {
      const before = tree();
      const applied = applyOpsWithChange(before, [op], "P");
      expect(applied.changed)
        .toBe(JSON.stringify(before) !== JSON.stringify(applied.blocks));
    });
  }

  test("a batch changed if any single op changed", () => {
    const before = tree();
    const applied = applyOpsWithChange(before, [
      { op: "update_text", uid: "a", text: "A" },   // no-op
      { op: "update_text", uid: "a", text: "A!" },  // real
      { op: "delete", uid: "zz" },                  // other page
    ], "P");
    expect(applied.changed).toBe(true);
    expect(findNode(applied.blocks, "a")!.text).toBe("A!");
  });

  test("applyOps is the same application without the flag", () => {
    const op: BlockOp = { op: "update_text", uid: "a", text: "A!" };
    expect(applyOps(tree(), [op], "P"))
      .toEqual(applyOpsWithChange(tree(), [op], "P").blocks);
  });
});

describe("applyOpsWithChange allocates nothing for a batch that misses this page", () => {
  // The websocket broadcasts every page's ops to every open outline, so the
  // common case is a batch none of whose ops concern this tree (pkm-a4wf).
  // Cloning it to throw the clone away costs one fresh node per block per
  // remote batch; these tests fail the moment the clone comes back.
  const elsewhere: BlockOp[] = [
    { op: "create", uid: "n1", page_title: "Other", parent_uid: null,
      order_idx: 0, text: "new" },
    { op: "create_page", page_title: "Other" },
    { op: "update_text", uid: "zz", text: "x" },
    { op: "set_collapsed", uid: "zz", collapsed: true },
    { op: "set_heading", uid: "zz", heading: 1 },
    { op: "set_view_type", uid: "zz", view_type: "numbered" },
    { op: "move", uid: "zz", parent_uid: null, order_idx: 0 },
    { op: "move", uid: "zz", parent_uid: null, order_idx: 0,
      page_title: "Other" },
    { op: "delete", uid: "zz" },
  ];

  test("returns the very tree it was given, nodes and all", () => {
    const before = tree();
    const applied = applyOpsWithChange(before, elsewhere, "P");
    expect(applied.changed).toBe(false);
    expect(applied.blocks).toBe(before);
    // Reference-identity all the way down: a clone would rebuild the nested
    // arrays and nodes even where the top-level array looked untouched.
    expect(applied.blocks[1]).toBe(before[1]);
    expect(applied.blocks[1].children).toBe(before[1].children);
    expect(applied.blocks[2].children[0]).toBe(before[2].children[0]);
  });

  test("each miss on its own returns the same tree", () => {
    for (const op of elsewhere) {
      const before = tree();
      expect(applyOpsWithChange(before, [op], "P").blocks,
             `cloned for ${op.op}`).toBe(before);
    }
  });

  test("one op landing on a nested uid still clones and applies the batch", () => {
    const before = tree();
    const applied = applyOpsWithChange(
      before, [...elsewhere, { op: "update_text", uid: "b2", text: "B2!" }], "P");
    expect(applied.changed).toBe(true);
    expect(applied.blocks).not.toBe(before);
    expect(findNode(applied.blocks, "b2")!.text).toBe("B2!");
    expect(findNode(before, "b2")!.text).toBe("B2"); // input untouched
  });

  test("a create for THIS page is never a miss, whatever it resolves to", () => {
    // Both of these apply nothing (uid already here / unknown parent), but
    // they are this page's ops: the skip may only key on relevance, never on
    // the outcome, or the change flag would start disagreeing with the tree.
    for (const op of [
      { op: "create", uid: "b", page_title: "P", parent_uid: null,
        order_idx: 5, text: "B" },
      { op: "create", uid: "n1", page_title: "P", parent_uid: "zz",
        order_idx: 0, text: "new" },
    ] satisfies BlockOp[]) {
      const before = tree();
      const applied = applyOpsWithChange(before, [op], "P");
      expect(applied.changed).toBe(false);
      expect(applied.blocks).toEqual(before);
    }
  });
});
