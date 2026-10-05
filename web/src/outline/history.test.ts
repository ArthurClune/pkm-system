import { expect, it } from "vitest";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { block, ord, uid } from "../test-helpers";
import { applyOps } from "./tree";
import { invertOps, emptyHistory, HISTORY_CAP, recordEntry, takeRedo, takeUndo,
         type HistoryEntry } from "./history";

const PAGE = "Test Page";

const tree = () => [
  block("a", "alpha", { order_idx: ord(0) }),
  block("b", "beta", {
    order_idx: ord(1),
    collapsed: true,
    children: [block("b1", "child", { order_idx: ord(0), heading: 2 })],
  }),
  block("c", "gamma", { order_idx: ord(2) }),
];

it("inverts create to delete", () => {
  const ops: BlockOp[] = [{ op: "create", uid: uid("n"), page_title: PAGE,
                            parent_uid: null, order_idx: ord(3), text: "new" }];
  expect(invertOps(tree(), PAGE, ops)).toEqual([{ op: "delete", uid: "n" }]);
});

it("inverts update_text to the pre-op text", () => {
  const ops: BlockOp[] = [{ op: "update_text", uid: uid("a"), text: "changed" }];
  expect(invertOps(tree(), PAGE, ops))
    .toEqual([{ op: "update_text", uid: "a", text: "alpha" }]);
});

it("inverts move back to the old parent and order_idx", () => {
  const ops: BlockOp[] = [{ op: "move", uid: uid("c"), parent_uid: uid("a"), order_idx: ord(0) }];
  expect(invertOps(tree(), PAGE, ops))
    .toEqual([{ op: "move", uid: "c", parent_uid: null, order_idx: 2 }]);
});

it("round-trips a move: apply ops then inverse restores the shape", () => {
  const before = tree();
  const ops: BlockOp[] = [{ op: "move", uid: uid("c"), parent_uid: uid("a"), order_idx: ord(0) }];
  const inverse = invertOps(before, PAGE, ops)!;
  const after = applyOps(applyOps(before, ops, PAGE), inverse, PAGE);
  // c is back at top level after b (order_idx values may differ; shape matters)
  expect(after.map((n) => n.uid)).toEqual(["a", "b", "c"]);
  expect(after[0].children).toEqual([]);
});

// Uids in sibling order, nested: what a reader sees, with order_idx values
// left out because a placement op only ever shifts keys up, so an undo can
// restore every position without restoring every key.
type Shape = (string | Shape)[];
const shape = (nodes: BlockNode[]): Shape =>
  nodes.flatMap((n) => n.children.length > 0 ? [n.uid, shape(n.children)] : [n.uid]);

const roundTrip = (before: BlockNode[], ops: BlockOp[]): BlockNode[] => {
  const inverse = invertOps(before, PAGE, ops)!;
  return applyOps(applyOps(before, ops, PAGE), inverse, PAGE);
};

const flat = (...uids: string[]) =>
  uids.map((u, i) => block(u, u, { order_idx: ord(i) }));

it("round-trips a move up: the swapped sibling took the old key", () => {
  // moveBlockUp b1: the move lands on b0's key, shifting b0 into b1's old one
  const before = flat("b0", "b1");
  const ops: BlockOp[] = [{ op: "move", uid: uid("b1"), parent_uid: null, order_idx: ord(0) }];
  expect(shape(roundTrip(before, ops))).toEqual(["b0", "b1"]);
});

it("round-trips a move up inside a parent", () => {
  const before = [block("p", "p", { order_idx: ord(0), children: flat("c0", "c1", "c2") })];
  const ops: BlockOp[] = [{ op: "move", uid: uid("c2"), parent_uid: uid("p"), order_idx: ord(1) }];
  expect(shape(roundTrip(before, ops))).toEqual(["p", ["c0", "c1", "c2"]]);
});

it("round-trips a selection move down (its next sibling moves up)", () => {
  // moveSelectionDown [b0, b1]: b2 moves to the run's first key
  const before = flat("b0", "b1", "b2", "b3");
  const ops: BlockOp[] = [{ op: "move", uid: uid("b2"), parent_uid: null, order_idx: ord(0) }];
  expect(shape(roundTrip(before, ops))).toEqual(["b0", "b1", "b2", "b3"]);
});

it("round-trips a selection move up (its previous sibling moves down)", () => {
  // moveSelectionUp [b2, b3]: b1 moves past the run's last block
  const before = flat("b0", "b1", "b2", "b3");
  const ops: BlockOp[] = [{ op: "move", uid: uid("b1"), parent_uid: null, order_idx: ord(4) }];
  expect(shape(roundTrip(before, ops))).toEqual(["b0", "b1", "b2", "b3"]);
});

it("round-trips a multi-block drop up within a parent", () => {
  // moveBlocksTo [c2, c3] before c0: groupMoveOps, one op per block, and the
  // second op shifts the siblings the first inverse will be placed among
  const before = [block("p", "p", { order_idx: ord(0), children: flat("c0", "c1", "c2", "c3") })];
  const ops: BlockOp[] = [
    { op: "move", uid: uid("c2"), parent_uid: uid("p"), order_idx: ord(0) },
    { op: "move", uid: uid("c3"), parent_uid: uid("p"), order_idx: ord(1) },
  ];
  expect(shape(roundTrip(before, ops))).toEqual(["p", ["c0", "c1", "c2", "c3"]]);
});

it("round-trips a multi-block move into another parent's middle", () => {
  // the source keeps its keys; the destination's siblings are shifted twice
  const before = [
    block("p", "p", { order_idx: ord(0), children: flat("c0", "c1") }),
    block("x", "x", { order_idx: ord(1) }),
    block("y", "y", { order_idx: ord(2) }),
  ];
  const ops: BlockOp[] = [
    { op: "move", uid: uid("x"), parent_uid: uid("p"), order_idx: ord(1) },
    { op: "move", uid: uid("y"), parent_uid: uid("p"), order_idx: ord(2) },
  ];
  expect(shape(roundTrip(before, ops))).toEqual(["p", ["c0", "c1"], "x", "y"]);
});

it("round-trips a delete whose old previous sibling a later op shifted", () => {
  const before = flat("b0", "b1", "b2");
  const ops: BlockOp[] = [
    { op: "delete", uid: uid("b1") },
    { op: "move", uid: uid("b2"), parent_uid: null, order_idx: ord(0) },
  ];
  expect(shape(roundTrip(before, ops))).toEqual(["b0", "b1", "b2"]);
});

it("round-trips a move whose old slot sat in a key gap", () => {
  // sparse keys: b's old key is still free between its neighbours
  const before = [block("a", "a", { order_idx: ord(0) }),
                  block("b", "b", { order_idx: ord(5) }),
                  block("c", "c", { order_idx: ord(9) })];
  const ops: BlockOp[] = [{ op: "move", uid: uid("b"), parent_uid: null, order_idx: ord(0) }];
  expect(shape(roundTrip(before, ops))).toEqual(["a", "b", "c"]);
});

it("inverts delete into creates for the whole subtree plus collapsed restore", () => {
  const ops: BlockOp[] = [{ op: "delete", uid: uid("b") }];
  expect(invertOps(tree(), PAGE, ops)).toEqual([
    { op: "create", uid: "b", page_title: PAGE, parent_uid: null,
      order_idx: 1, text: "beta", heading: null, view_type: null },
    { op: "create", uid: "b1", page_title: PAGE, parent_uid: "b",
      order_idx: 0, text: "child", heading: 2, view_type: null },
    { op: "set_collapsed", uid: "b", collapsed: true },
  ]);
});

it("inverts set_heading and set_view_type to old values", () => {
  expect(invertOps(tree(), PAGE, [{ op: "set_heading", uid: uid("b1"), heading: null }]))
    .toEqual([{ op: "set_heading", uid: "b1", heading: 2 }]);
  expect(invertOps(tree(), PAGE, [{ op: "set_view_type", uid: uid("a"), view_type: "numbered" }]))
    .toEqual([{ op: "set_view_type", uid: "a", view_type: "document" }]);
});

it("drops set_collapsed from inverses (collapse-only batch inverts to [])", () => {
  expect(invertOps(tree(), PAGE, [{ op: "set_collapsed", uid: uid("b"), collapsed: false }]))
    .toEqual([]);
});

it("drops set_collapsed riders but keeps the rest (indent auto-expand)", () => {
  const ops: BlockOp[] = [
    { op: "set_collapsed", uid: uid("b"), collapsed: false },
    { op: "move", uid: uid("c"), parent_uid: uid("b"), order_idx: ord(1) },
  ];
  expect(invertOps(tree(), PAGE, ops))
    .toEqual([{ op: "move", uid: "c", parent_uid: null, order_idx: 2 }]);
});

it("reverses multi-op batches op-by-op (split: update_text + create)", () => {
  const ops: BlockOp[] = [
    { op: "update_text", uid: uid("a"), text: "al" },
    { op: "create", uid: uid("n"), page_title: PAGE, parent_uid: null,
      order_idx: ord(1), text: "pha" },
  ];
  expect(invertOps(tree(), PAGE, ops)).toEqual([
    { op: "delete", uid: "n" },
    { op: "update_text", uid: "a", text: "alpha" },
  ]);
});

it("simulates sequential ops against the evolving tree", () => {
  // second op edits the block the first op created
  const ops: BlockOp[] = [
    { op: "create", uid: uid("n"), page_title: PAGE, parent_uid: null,
      order_idx: ord(3), text: "first" },
    { op: "update_text", uid: uid("n"), text: "second" },
  ];
  expect(invertOps(tree(), PAGE, ops)).toEqual([
    { op: "update_text", uid: "n", text: "first" },
    { op: "delete", uid: "n" },
  ]);
});

it("keeps a deleted subtree's create group in parent-first order when reversed", () => {
  const ops: BlockOp[] = [
    { op: "update_text", uid: uid("a"), text: "x" },
    { op: "delete", uid: uid("b") },
  ];
  const inverse = invertOps(tree(), PAGE, ops)!;
  // group order reversed, but within the delete-inverse parents precede children
  expect(inverse.map((o) => o.op))
    .toEqual(["create", "create", "set_collapsed", "update_text"]);
  expect(inverse[0]).toMatchObject({ uid: "b" });
  expect(inverse[1]).toMatchObject({ uid: "b1", parent_uid: "b" });
});

it("returns null for ops on unknown blocks (cross-page move source)", () => {
  expect(invertOps(tree(), PAGE, [{ op: "move", uid: uid("zz"), parent_uid: null,
                                    order_idx: ord(0) }])).toBeNull();
  expect(invertOps(tree(), PAGE, [{ op: "update_text", uid: uid("zz"), text: "x" }]))
    .toBeNull();
});

it("returns null for a move that leaves this page", () => {
  expect(invertOps(tree(), PAGE, [{ op: "move", uid: uid("c"), parent_uid: null,
                                    order_idx: ord(0), page_title: "Other" }]))
    .toBeNull();
});

it("returns [] for create_page (additive, nothing to undo)", () => {
  expect(invertOps(tree(), PAGE, [{ op: "create_page", page_title: "New" }]))
    .toEqual([]);
});

const entry = (n: number): HistoryEntry => ({
  pageTitle: PAGE,
  ops: [{ op: "update_text", uid: uid("a"), text: `v${n}` }],
  inverse: [{ op: "update_text", uid: uid("a"), text: `v${n - 1}` }],
  focusBefore: null,
  focusAfter: null,
});

it("undo pops LIFO and moves the entry to the redo stack", () => {
  let s = recordEntry(recordEntry(emptyHistory(), entry(1)), entry(2));
  const u1 = takeUndo(s);
  expect(u1.entry).toEqual(entry(2));
  const r = takeRedo(u1.state);
  expect(r.entry).toEqual(entry(2));
  expect(takeUndo(r.state).entry).toEqual(entry(2)); // redone entry is undoable again
});

it("returns null entry on empty stacks", () => {
  expect(takeUndo(emptyHistory()).entry).toBeNull();
  expect(takeRedo(emptyHistory()).entry).toBeNull();
});

it("recording clears the redo stack (AC: new op invalidates redo)", () => {
  let s = recordEntry(emptyHistory(), entry(1));
  s = takeUndo(s).state;
  expect(s.redo).toHaveLength(1);
  s = recordEntry(s, entry(2));
  expect(s.redo).toHaveLength(0);
});

it("caps the undo stack, evicting the oldest", () => {
  let s = emptyHistory();
  for (let i = 0; i < HISTORY_CAP + 5; i++) s = recordEntry(s, entry(i));
  expect(s.undo).toHaveLength(HISTORY_CAP);
  expect(s.undo[0]).toEqual(entry(5)); // oldest five evicted
});
