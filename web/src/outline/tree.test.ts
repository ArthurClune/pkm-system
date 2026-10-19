import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { block, orderIdxOf, uidOf, rawTitleOf } from "../test-helpers";
import { ancestorChain, applyOps, applyOpsWithChange, blocksEqual, findNode,
         hidesChildren, hidingAncestors, insertSubtree, locate, needsAuthoritativeReload,
         removeSubtree, selectableUids, visibleNeighbor,
         visibleUids } from "./tree";

// Siblings with order_idx GAPS (0, 5, 7) — the server leaves gaps after
// shifts; every helper must key on order_idx values, never array positions.
const tree = () => [
  block("tuid-a", "A", { order_idx: orderIdxOf(0) }),
  block("tuid-b", "B", {
    order_idx: orderIdxOf(5),
    children: [
      block("tuid-b1", "B1", { order_idx: orderIdxOf(0) }),
      block("tuid-b2", "B2", { order_idx: orderIdxOf(3) }),
    ],
  }),
  block("tuid-c", "C", { order_idx: orderIdxOf(7), collapsed: true,
                         children: [block("tuid-c1", "C1", { order_idx: orderIdxOf(0) })] }),
];

describe("locate / visibility", () => {
  test("locate finds nested nodes with parent and index", () => {
    const found = locate(tree(), uidOf("tuid-b2"))!;
    expect(found.node.uid).toBe("tuid-b2");
    expect(found.parent?.uid).toBe("tuid-b");
    expect(found.index).toBe(1);
    expect(found.siblings.map((s) => s.uid)).toEqual(["tuid-b1", "tuid-b2"]);
    expect(locate(tree(), uidOf("tuid-nope"))).toBeNull();
  });

  test("visibleUids skips children of collapsed blocks", () => {
    expect(visibleUids(tree())).toEqual(["tuid-a", "tuid-b", "tuid-b1", "tuid-b2", "tuid-c"]);
  });

  test("visibleNeighbor walks the on-screen order", () => {
    expect(visibleNeighbor(tree(), uidOf("tuid-b2"), "down")).toBe("tuid-c");
    expect(visibleNeighbor(tree(), uidOf("tuid-b"), "up")).toBe("tuid-a");
    expect(visibleNeighbor(tree(), uidOf("tuid-a"), "up")).toBeNull();
    expect(visibleNeighbor(tree(), uidOf("tuid-c"), "down")).toBeNull();
  });
});

describe("applyOps mirrors ops_apply.py", () => {
  test("create shifts later siblings and inserts sorted", () => {
    const op: BlockOp = { op: "create", uid: uidOf("tuid-n1"), page_title: rawTitleOf("P"),
                          parent_uid: null, order_idx: orderIdxOf(5), text: "new",
                          view_type: "numbered" };
    const out = applyOps(tree(), [op], rawTitleOf("P"));
    expect(out.map((n) => [n.uid, n.order_idx])).toEqual(
      [["tuid-a", 0], ["tuid-n1", 5], ["tuid-b", 6], ["tuid-c", 8]]);
    expect(findNode(out, uidOf("tuid-n1"))!.view_type).toBe("numbered");
  });

  test("create for another page is skipped", () => {
    const op: BlockOp = { op: "create", uid: uidOf("tuid-n1"), page_title: rawTitleOf("Other"),
                          parent_uid: null, order_idx: orderIdxOf(0), text: "x" };
    expect(applyOps(tree(), [op], rawTitleOf("P")).map((n) => n.uid)).toEqual(["tuid-a", "tuid-b", "tuid-c"]);
  });

  test("move follows insert-before-pre-removal semantics ([A,B,C] A->2 = [B,A,C])", () => {
    const abc = [block("tuid-a", "A", { order_idx: orderIdxOf(0) }),
                 block("tuid-b", "B", { order_idx: orderIdxOf(1) }),
                 block("tuid-c", "C", { order_idx: orderIdxOf(2) })];
    const op: BlockOp = { op: "move", uid: uidOf("tuid-a"), parent_uid: null, order_idx: orderIdxOf(2) };
    const out = applyOps(abc, [op], rawTitleOf("P"));
    expect(out.map((n) => n.uid)).toEqual(["tuid-b", "tuid-a", "tuid-c"]);
    expect(out.map((n) => n.order_idx)).toEqual([1, 2, 3]);
  });

  test("move reparents into a nested target", () => {
    const op: BlockOp = { op: "move", uid: uidOf("tuid-a"), parent_uid: uidOf("tuid-b"), order_idx: orderIdxOf(3) };
    const out = applyOps(tree(), [op], rawTitleOf("P"));
    expect(out.map((n) => n.uid)).toEqual(["tuid-b", "tuid-c"]);
    expect(findNode(out, uidOf("tuid-b"))!.children.map((n) => [n.uid, n.order_idx]))
      .toEqual([["tuid-b1", 0], ["tuid-a", 3], ["tuid-b2", 4]]);
  });

  test("delete removes the whole subtree; update_text and set_collapsed hit the node", () => {
    const out = applyOps(tree(), [
      { op: "delete", uid: uidOf("tuid-b") },
      { op: "update_text", uid: uidOf("tuid-a"), text: "A!" },
      { op: "set_collapsed", uid: uidOf("tuid-c"), collapsed: false },
    ], rawTitleOf("P"));
    expect(out.map((n) => n.uid)).toEqual(["tuid-a", "tuid-c"]);
    expect(findNode(out, uidOf("tuid-a"))!.text).toBe("A!");
    expect(findNode(out, uidOf("tuid-c"))!.collapsed).toBe(false);
    expect(findNode(out, uidOf("tuid-b1"))).toBeNull();
  });

  test("set_heading sets or clears the node's heading (applies to remote batches too)", () => {
    const out = applyOps(tree(), [
      { op: "set_heading", uid: uidOf("tuid-a"), heading: 2 },
    ], rawTitleOf("P"));
    expect(findNode(out, uidOf("tuid-a"))!.heading).toBe(2);
    const cleared = applyOps(out, [
      { op: "set_heading", uid: uidOf("tuid-a"), heading: null },
    ], rawTitleOf("P"));
    expect(findNode(cleared, uidOf("tuid-a"))!.heading).toBeNull();
  });

  test("set_view_type updates only persistent presentation metadata", () => {
    const before = tree();
    const out = applyOps(before, [
      { op: "set_view_type", uid: uidOf("tuid-b"), view_type: "numbered" },
    ], rawTitleOf("P"));
    expect(findNode(out, uidOf("tuid-b"))!.view_type).toBe("numbered");
    expect(findNode(out, uidOf("tuid-b"))!.text).toBe(findNode(before, uidOf("tuid-b"))!.text);
    expect(findNode(out, uidOf("tuid-b"))!.collapsed).toBe(findNode(before, uidOf("tuid-b"))!.collapsed);
    expect(findNode(out, uidOf("tuid-b"))!.children.map((n) => n.uid))
      .toEqual(findNode(before, uidOf("tuid-b"))!.children.map((n) => n.uid));
  });

  test("ops for uids not in this tree (other pages on the ws) are skipped", () => {
    const out = applyOps(tree(), [
      { op: "update_text", uid: uidOf("tuid-zz"), text: "x" },
      { op: "delete", uid: uidOf("tuid-zz") },
      { op: "move", uid: uidOf("tuid-zz"), parent_uid: null, order_idx: orderIdxOf(0) },
      { op: "set_collapsed", uid: uidOf("tuid-zz"), collapsed: true },
      { op: "set_heading", uid: uidOf("tuid-zz"), heading: 1 },
      { op: "set_view_type", uid: uidOf("tuid-zz"), view_type: "numbered" },
    ], rawTitleOf("P"));
    expect(out.map((n) => n.uid)).toEqual(["tuid-a", "tuid-b", "tuid-c"]);
  });

  test("does not mutate its input", () => {
    const input = tree();
    applyOps(input, [{ op: "update_text", uid: uidOf("tuid-a"), text: "changed" }], rawTitleOf("P"));
    expect(input[0].text).toBe("A");
  });

  test("applyOps removes the subtree when a move targets another page", () => {
    const tree = [block("tuid-a", "A"), { ...block("tuid-b", "B"), children: [block("tuid-c", "C")] }];
    const next = applyOps(tree, [
      { op: "move", uid: uidOf("tuid-b"), parent_uid: null, order_idx: orderIdxOf(0),
        page_title: rawTitleOf("Elsewhere") }], rawTitleOf("Here"));
    expect(next.map((n) => n.uid)).toEqual(["tuid-a"]);
  });

  test("applyOps still applies a move whose page_title names this page", () => {
    const tree = [block("tuid-a", "A", { order_idx: orderIdxOf(0) }),
                  block("tuid-b", "B", { order_idx: orderIdxOf(1) })];
    const next = applyOps(tree, [
      { op: "move", uid: uidOf("tuid-b"), parent_uid: null, order_idx: orderIdxOf(0),
        page_title: rawTitleOf("Here") }], rawTitleOf("Here"));
    expect(next.map((n) => n.uid)).toEqual(["tuid-b", "tuid-a"]);
  });

  test("removeSubtree detaches a nested subtree and returns it", () => {
    const tree = [{ ...block("tuid-a", "A"), children: [
      { ...block("tuid-b", "B"), children: [block("tuid-c", "C")] }] }];
    const { tree: next, node } = removeSubtree(tree, uidOf("tuid-b"));
    expect(node?.uid).toBe("tuid-b");
    expect(node?.children.map((n) => n.uid)).toEqual(["tuid-c"]);
    expect(next[0].children).toEqual([]);
    expect(tree[0].children.length).toBe(1); // input not mutated
  });

  test("insertSubtree inserts before the sibling at order_idx", () => {
    const tree = [block("tuid-x", "X", { order_idx: orderIdxOf(0) }),
                  block("tuid-y", "Y", { order_idx: orderIdxOf(1) })];
    const node = block("tuid-n", "N");
    const next = insertSubtree(tree, node, null, orderIdxOf(1));
    expect(next.map((n) => n.uid)).toEqual(["tuid-x", "tuid-n", "tuid-y"]);
  });

  test("insertSubtree returns the tree unchanged for an unknown parentUid", () => {
    const before = tree();
    const next = insertSubtree(before, block("tuid-n", "N"), uidOf("tuid-nope"), orderIdxOf(0));
    expect(next).toEqual(before);      // value-equal (a fresh clone)
    expect(findNode(next, uidOf("tuid-n"))).toBeNull();
  });

  test("insertSubtree inserts under a nested (non-null) parent", () => {
    // b has children b1(0), b2(3); insert at order_idx 3 → before b2, which
    // shifts up. Positions key on order_idx, never array index.
    const next = insertSubtree(tree(), block("tuid-n", "N"), uidOf("tuid-b"), orderIdxOf(3));
    const parent = findNode(next, uidOf("tuid-b"))!;
    expect(parent.children.map((c) => c.uid)).toEqual(["tuid-b1", "tuid-n", "tuid-b2"]);
    expect(parent.children.map((c) => c.order_idx)).toEqual([0, 3, 4]);
  });

  test("insertSubtree deep-clones the inserted node's children", () => {
    const tree = [block("tuid-x", "X", { order_idx: orderIdxOf(0) }),
                  block("tuid-y", "Y", { order_idx: orderIdxOf(1) })];
    const node = { ...block("tuid-n", "N"), children: [block("tuid-c1", "C1")] };
    const next = insertSubtree(tree, node, null, orderIdxOf(1));
    // Mutate the original node's children
    node.children.push(block("tuid-c2", "C2"));
    // The returned tree should still have only the original child
    const insertedNode = findNode(next, uidOf("tuid-n"))!;
    expect(insertedNode.children.length).toBe(1);
    expect(insertedNode.children[0].uid).toBe("tuid-c1");
  });
});

describe("hidesChildren", () => {
  const table = (text: string) => block("tuid-t", text, { collapsed: true, children: [
    block("tuid-r1", "a", { children: [block("tuid-r1b", "b")] }),
  ] });

  test("a collapsed block with children hides them", () => {
    expect(hidesChildren(block("tuid-p", "p", { collapsed: true,
                                           children: [block("tuid-c", "c")] }))).toBe(true);
  });

  test("an expanded block, or a collapsed one with no children, hides nothing", () => {
    expect(hidesChildren(block("tuid-p", "p", { children: [block("tuid-c", "c")] }))).toBe(false);
    expect(hidesChildren(block("tuid-p", "p", { collapsed: true }))).toBe(false);
  });

  test("a collapsed Roam table still shows its rows", () => {
    expect(hidesChildren(table("{{[[table]]}}"))).toBe(false);
    expect(hidesChildren(table("{{table}}"))).toBe(false);
  });

  test("a collapsed block whose text is not a table macro hides its rows", () => {
    expect(hidesChildren(table("{{[[table]]}} notes"))).toBe(true);
  });
});

describe("hidingAncestors", () => {
  const t = () => [
    block("tuid-g", "g", { collapsed: true, children: [
      block("tuid-m", "m", { children: [
        block("tuid-tbl", "{{table}}", { collapsed: true, children: [
          block("tuid-r1", "a", { children: [block("tuid-r1b", "b")] }),
        ] }),
      ] }),
    ] }),
  ];

  test("lists the collapsed ancestors that keep a block off screen, outermost first", () => {
    expect(hidingAncestors(t(), uidOf("tuid-r1b"))).toEqual(["tuid-g"]);
    expect(hidingAncestors(t(), uidOf("tuid-m"))).toEqual(["tuid-g"]);
  });

  test("empty for a block on screen, a top-level block, or one not in the tree", () => {
    const shown = [block("tuid-p", "p", { children: [block("tuid-c", "c")] })];
    expect(hidingAncestors(shown, uidOf("tuid-c"))).toEqual([]);
    expect(hidingAncestors(t(), uidOf("tuid-g"))).toEqual([]);
    expect(hidingAncestors(t(), uidOf("nowhere"))).toEqual([]);
  });
});

describe("visibleUids and a collapsed Roam table", () => {
  const cells = () => [
    block("tuid-r1", "a", { children: [block("tuid-r1b", "b")] }),
    block("tuid-r2", "c", { children: [block("tuid-r2b", "d")] }),
  ];
  const withTable = (text: string, rows: BlockNode[]) => [
    block("tuid-t", text, { collapsed: true, children: rows }),
    block("tuid-after", "after"),
  ];

  test("a collapsed valid table's cells stay in the on-screen order", () => {
    expect(visibleUids(withTable("{{table}}", cells())))
      .toEqual(["tuid-t", "tuid-r1", "tuid-r1b", "tuid-r2", "tuid-r2b", "tuid-after"]);
  });

  test("a collapsed table-shaped block that is not a valid table hides its children", () => {
    const bad = [block("tuid-r1", "a", { children: [block("tuid-x", "x"), block("tuid-y", "y")] })];
    expect(visibleUids(withTable("{{table}}", bad))).toEqual(["tuid-t", "tuid-after"]);
    expect(visibleUids(withTable("notes", cells()))).toEqual(["tuid-t", "tuid-after"]);
  });

  test("visibleNeighbor steps from a collapsed table into its first cell", () => {
    expect(visibleNeighbor(withTable("{{table}}", cells()), uidOf("tuid-t"), "down")).toBe("tuid-r1");
  });
});

describe("selectableUids", () => {
  const cells = () => [block("tuid-r1", "a", { children: [block("tuid-r1b", "b")] })];

  test("a valid table is one row whether collapsed or not", () => {
    for (const collapsed of [true, false]) {
      const blocks = [block("tuid-t", "{{table}}", { collapsed, children: cells() }),
                      block("tuid-after", "after")];
      expect(selectableUids(blocks)).toEqual(["tuid-t", "tuid-after"]);
    }
  });

  test("ordinary expanded blocks and an invalid table keep their children", () => {
    const bad = [block("tuid-r1", "a", { children: [block("tuid-x", "x"), block("tuid-y", "y")] })];
    expect(selectableUids([block("tuid-p", "p", { children: [block("tuid-q", "q")] })]))
      .toEqual(["tuid-p", "tuid-q"]);
    expect(selectableUids([block("tuid-t", "{{table}}", { children: bad })]))
      .toEqual(["tuid-t", "tuid-r1", "tuid-x", "tuid-y"]);
  });

  test("a collapsed ordinary block or invalid table hides its children", () => {
    const bad = [block("tuid-r1", "a", { children: [block("tuid-x", "x"), block("tuid-y", "y")] })];
    expect(selectableUids([block("tuid-t", "{{table}}", { collapsed: true, children: bad })]))
      .toEqual(["tuid-t"]);
    expect(selectableUids([block("tuid-c", "c", { collapsed: true, children: cells() })]))
      .toEqual(["tuid-c"]);
  });
});

describe("ancestorChain", () => {
  test("returns the path from the outermost ancestor down to the uid", () => {
    expect(ancestorChain(tree(), uidOf("tuid-b2"))).toEqual(["tuid-b", "tuid-b2"]);
    expect(ancestorChain(tree(), uidOf("tuid-a"))).toEqual(["tuid-a"]);
  });

  test("pops branches it abandoned, so no unrelated ancestor is reported", () => {
    // c1 sits under c; a DFS that forgot to pop would prefix a and b.
    expect(ancestorChain(tree(), uidOf("tuid-c1"))).toEqual(["tuid-c", "tuid-c1"]);
  });

  test("returns nothing for a uid this tree does not hold", () => {
    expect(ancestorChain(tree(), uidOf("tuid-zz"))).toEqual([]);
  });
});

describe("blocksEqual", () => {
  test("holds for separate clones of the same tree and for one array twice", () => {
    const same = tree();
    expect(blocksEqual(same, same)).toBe(true);
    expect(blocksEqual(tree(), tree())).toBe(true);
  });

  test("fails on sibling count and on sibling order", () => {
    const a = [block("tuid-x", "X", { order_idx: orderIdxOf(0) }),
               block("tuid-y", "Y", { order_idx: orderIdxOf(1) })];
    expect(blocksEqual(a, [a[0]])).toBe(false);
    expect(blocksEqual(a, [a[1], a[0]])).toBe(false);
  });

  test("fails on a difference in any BlockNode field", () => {
    // A field this compare forgets would be a silently missed change, so the
    // sweep is over the node's real keys: a new payload field fails here.
    const base = block("tuid-u1", "text", {
      heading: 2, view_type: "numbered", collapsed: true, order_idx: orderIdxOf(3),
      created_at: 1, updated_at: 2, children: [block("tuid-kid", "K")],
    });
    for (const field of Object.keys(base)) {
      const value = base[field as keyof BlockNode];
      const other = typeof value === "string" ? `${value}!`
        : typeof value === "number" ? value + 1
        : typeof value === "boolean" ? !value
        : [];
      const changed: BlockNode = { ...base, [field]: other };
      expect(blocksEqual([base], [changed]),
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
    ["a create for this page", { op: "create", uid: uidOf("tuid-n1"), page_title: rawTitleOf("P"),
                                 parent_uid: null, order_idx: orderIdxOf(5), text: "new" }],
    ["a create for another page", { op: "create", uid: uidOf("tuid-n1"),
                                    page_title: rawTitleOf("Other"), parent_uid: null,
                                    order_idx: orderIdxOf(0), text: "new" }],
    ["a create replaying a uid already here", {
      op: "create", uid: uidOf("tuid-b"), page_title: rawTitleOf("P"), parent_uid: null,
      order_idx: orderIdxOf(5), text: "B" }],
    ["a create under a parent this tree does not hold", {
      op: "create", uid: uidOf("tuid-n1"), page_title: rawTitleOf("P"), parent_uid: uidOf("tuid-zz"),
      order_idx: orderIdxOf(0), text: "new" }],
    ["a page creation", { op: "create_page", page_title: rawTitleOf("Other") }],
    ["update_text to a different text", {
      op: "update_text", uid: uidOf("tuid-a"), text: "A!" }],
    ["update_text to the text already there", {
      op: "update_text", uid: uidOf("tuid-a"), text: "A" }],
    ["set_collapsed flipping the flag", {
      op: "set_collapsed", uid: uidOf("tuid-a"), collapsed: true }],
    ["set_collapsed to the value already there", {
      op: "set_collapsed", uid: uidOf("tuid-a"), collapsed: false }],
    ["set_heading to a heading", { op: "set_heading", uid: uidOf("tuid-a"), heading: 2 }],
    ["set_heading clearing an already-absent heading", {
      op: "set_heading", uid: uidOf("tuid-a"), heading: null }],
    ["set_view_type to a view", {
      op: "set_view_type", uid: uidOf("tuid-a"), view_type: "numbered" }],
    ["a delete", { op: "delete", uid: uidOf("tuid-b") }],
    ["a delete of a uid not here", { op: "delete", uid: uidOf("tuid-zz") }],
    ["a move that shifts a later sibling", {
      op: "move", uid: uidOf("tuid-a"), parent_uid: null, order_idx: orderIdxOf(5) }],
    ["a move that lands a top-level block back where it was", {
      op: "move", uid: uidOf("tuid-c"), parent_uid: null, order_idx: orderIdxOf(7) }],
    ["a move that lands a nested block back where it was", {
      op: "move", uid: uidOf("tuid-b2"), parent_uid: uidOf("tuid-b"), order_idx: orderIdxOf(3) }],
    ["a move that reparents", {
      op: "move", uid: uidOf("tuid-a"), parent_uid: uidOf("tuid-b"), order_idx: orderIdxOf(3) }],
    ["a move whose page_title names another page", {
      op: "move", uid: uidOf("tuid-b"), parent_uid: null, order_idx: orderIdxOf(0),
      page_title: rawTitleOf("Elsewhere") }],
    ["a move under a parent this tree does not hold", {
      op: "move", uid: uidOf("tuid-a"), parent_uid: uidOf("tuid-zz"), order_idx: orderIdxOf(0) }],
    ["a move of a uid not here", {
      op: "move", uid: uidOf("tuid-zz"), parent_uid: null, order_idx: orderIdxOf(0) }],
  ];

  for (const [name, op] of cases) {
    test(name, () => {
      const before = tree();
      const applied = applyOpsWithChange(before, [op], rawTitleOf("P"));
      expect(applied.changed)
        .toBe(JSON.stringify(before) !== JSON.stringify(applied.blocks));
    });
  }

  // set_view_type's wire type has no null (SetViewTypeOp.view_type is
  // "numbered" | "document" only, unlike BlockNode.view_type), so its no-op
  // variant needs a block already holding one of those views -- tree()'s
  // blocks all start at the default null and can't exercise it.
  test("set_view_type to the view already there", () => {
    const before = tree().map((n) =>
      n.uid === "tuid-a" ? { ...n, view_type: "numbered" as const } : n);
    const op: BlockOp = { op: "set_view_type", uid: uidOf("tuid-a"), view_type: "numbered" };
    const applied = applyOpsWithChange(before, [op], rawTitleOf("P"));
    expect(applied.changed)
      .toBe(JSON.stringify(before) !== JSON.stringify(applied.blocks));
  });

  test("a batch changed if any single op changed", () => {
    const before = tree();
    const applied = applyOpsWithChange(before, [
      { op: "update_text", uid: uidOf("tuid-a"), text: "A" },   // no-op
      { op: "update_text", uid: uidOf("tuid-a"), text: "A!" },  // real
      { op: "delete", uid: uidOf("tuid-zz") },                  // other page
    ], rawTitleOf("P"));
    expect(applied.changed).toBe(true);
    expect(findNode(applied.blocks, uidOf("tuid-a"))!.text).toBe("A!");
  });

  test("applyOps is the same application without the flag", () => {
    const op: BlockOp = { op: "update_text", uid: uidOf("tuid-a"), text: "A!" };
    expect(applyOps(tree(), [op], rawTitleOf("P")))
      .toEqual(applyOpsWithChange(tree(), [op], rawTitleOf("P")).blocks);
  });
});

describe("applyOpsWithChange allocates nothing for a batch that misses this page", () => {
  // The websocket broadcasts every page's ops to every open outline, so the
  // common case is a batch none of whose ops concern this tree.
  // Cloning it to throw the clone away costs one fresh node per block per
  // remote batch; these tests fail the moment the clone comes back.
  const elsewhere: BlockOp[] = [
    { op: "create", uid: uidOf("tuid-n1"), page_title: rawTitleOf("Other"), parent_uid: null,
      order_idx: orderIdxOf(0), text: "new" },
    { op: "create_page", page_title: rawTitleOf("Other") },
    { op: "update_text", uid: uidOf("tuid-zz"), text: "x" },
    { op: "set_collapsed", uid: uidOf("tuid-zz"), collapsed: true },
    { op: "set_heading", uid: uidOf("tuid-zz"), heading: 1 },
    { op: "set_view_type", uid: uidOf("tuid-zz"), view_type: "numbered" },
    { op: "move", uid: uidOf("tuid-zz"), parent_uid: null, order_idx: orderIdxOf(0) },
    { op: "move", uid: uidOf("tuid-zz"), parent_uid: null, order_idx: orderIdxOf(0),
      page_title: rawTitleOf("Other") },
    { op: "delete", uid: uidOf("tuid-zz") },
  ];

  test("returns the very tree it was given, nodes and all", () => {
    const before = tree();
    const applied = applyOpsWithChange(before, elsewhere, rawTitleOf("P"));
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
      expect(applyOpsWithChange(before, [op], rawTitleOf("P")).blocks,
             `cloned for ${op.op}`).toBe(before);
    }
  });

  test("one op landing on a nested uid still clones and applies the batch", () => {
    const before = tree();
    const applied = applyOpsWithChange(
      before, [...elsewhere, { op: "update_text", uid: uidOf("tuid-b2"), text: "B2!" }], rawTitleOf("P"));
    expect(applied.changed).toBe(true);
    expect(applied.blocks).not.toBe(before);
    expect(findNode(applied.blocks, uidOf("tuid-b2"))!.text).toBe("B2!");
    expect(findNode(before, uidOf("tuid-b2"))!.text).toBe("B2"); // input untouched
  });

  test("a create for THIS page is never a miss, whatever it resolves to", () => {
    // Both of these apply nothing (uid already here / unknown parent), but
    // they are this page's ops: the skip may only key on relevance, never on
    // the outcome, or the change flag would start disagreeing with the tree.
    for (const op of [
      { op: "create", uid: uidOf("tuid-b"), page_title: rawTitleOf("P"), parent_uid: null,
        order_idx: orderIdxOf(5), text: "B" },
      { op: "create", uid: uidOf("tuid-n1"), page_title: rawTitleOf("P"), parent_uid: uidOf("tuid-zz"),
        order_idx: orderIdxOf(0), text: "new" },
    ] satisfies BlockOp[]) {
      const before = tree();
      const applied = applyOpsWithChange(before, [op], rawTitleOf("P"));
      expect(applied.changed).toBe(false);
      expect(applied.blocks).toEqual(before);
    }
  });
});

describe("needsAuthoritativeReload", () => {
  const move = (u: string, page_title: string | null): BlockOp => ({
    op: "move", uid: uidOf(u), parent_uid: null, order_idx: orderIdxOf(0),
    page_title: page_title === null ? null : rawTitleOf(page_title),
  });

  test("true for a move into this page of a uid the tree lacks", () => {
    expect(needsAuthoritativeReload(tree(), [move("tuid-zz", "P")], rawTitleOf("P"))).toBe(true);
  });
  test("false when the uid is present", () => {
    expect(needsAuthoritativeReload(tree(), [move("tuid-b1", "P")], rawTitleOf("P"))).toBe(false);
  });
  test("false when page_title is null", () => {
    expect(needsAuthoritativeReload(tree(), [move("tuid-zz", null)], rawTitleOf("P"))).toBe(false);
  });
  test("false for a move naming another page", () => {
    expect(needsAuthoritativeReload(tree(), [move("tuid-zz", "Q")], rawTitleOf("P"))).toBe(false);
  });
  test("false for non-move ops on absent uids", () => {
    const ops: BlockOp[] = [
      { op: "delete", uid: uidOf("tuid-zz") },
      { op: "update_text", uid: uidOf("tuid-zz"), text: "x" },
    ];
    expect(needsAuthoritativeReload(tree(), ops, rawTitleOf("P"))).toBe(false);
  });
  test("true when one batch moves a present block off the page and back", () => {
    // The echo removes "tuid-a" on the first move and cannot place it on the
    // second, so the rule is asked of the tree as each op leaves it.
    expect(needsAuthoritativeReload(
      tree(), [move("tuid-a", "Q"), move("tuid-a", "P")], rawTitleOf("P"))).toBe(true);
  });
  test("true when a batch moves a parent off the page and then its child onto it", () => {
    // The first move takes "tuid-b1" away with its parent "tuid-b", so the
    // echo cannot place "tuid-b1" on the second.
    expect(needsAuthoritativeReload(
      tree(), [move("tuid-b", "Q"), move("tuid-b1", "P")], rawTitleOf("P"))).toBe(true);
  });
  test("false when the batch created the block on this page before moving it", () => {
    const ops: BlockOp[] = [
      { op: "create", uid: uidOf("tuid-zz"), parent_uid: null, order_idx: orderIdxOf(9),
        text: "Z", page_title: rawTitleOf("P") },
      move("tuid-zz", "P"),
    ];
    expect(needsAuthoritativeReload(tree(), ops, rawTitleOf("P"))).toBe(false);
  });
  test("false for a batch that only moves a present block off the page", () => {
    expect(needsAuthoritativeReload(tree(), [move("tuid-a", "Q")], rawTitleOf("P"))).toBe(false);
  });
  test("leaves the caller's tree untouched", () => {
    const blocks = tree();
    needsAuthoritativeReload(blocks, [move("tuid-a", "Q"), move("tuid-a", "P")], rawTitleOf("P"));
    expect(blocks).toEqual(tree());
  });
});
