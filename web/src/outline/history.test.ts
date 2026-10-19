import { expect, it } from "vitest";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { block, orderIdxOf, uidOf, shaOf } from "../test-helpers";
import { applyOps } from "./tree";
import { invertOps, emptyHistory, historyAnchors, HISTORY_CAP, recordEntry,
         resolveAnchors, takeRedo, takeUndo, type HistoryEntry,
         type HistoryState } from "./history";

const PAGE = "Test Page";

const tree = () => [
  block("tuid-a", "alpha", { order_idx: orderIdxOf(0) }),
  block("tuid-b", "beta", {
    order_idx: orderIdxOf(1),
    collapsed: true,
    children: [block("tuid-b1", "child", { order_idx: orderIdxOf(0), heading: 2 })],
  }),
  block("tuid-c", "gamma", { order_idx: orderIdxOf(2) }),
];

it("inverts create to delete", () => {
  const ops: BlockOp[] = [{ op: "create", uid: uidOf("tuid-n"), page_title: PAGE,
                            parent_uid: null, order_idx: orderIdxOf(3), text: "new" }];
  expect(invertOps(tree(), PAGE, ops)).toEqual([{ op: "delete", uid: "tuid-n" }]);
});

it("inverts update_text to the pre-op text", () => {
  const ops: BlockOp[] = [{ op: "update_text", uid: uidOf("tuid-a"), text: "changed" }];
  expect(invertOps(tree(), PAGE, ops))
    .toEqual([{ op: "update_text", uid: "tuid-a", text: "alpha" }]);
});

it("inverts move back to the old parent and order_idx", () => {
  const ops: BlockOp[] = [{ op: "move", uid: uidOf("tuid-c"), parent_uid: uidOf("tuid-a"), order_idx: orderIdxOf(0) }];
  expect(invertOps(tree(), PAGE, ops))
    .toEqual([{ op: "move", uid: "tuid-c", parent_uid: null, order_idx: 2 }]);
});

it("round-trips a move: apply ops then inverse restores the shape", () => {
  const before = tree();
  const ops: BlockOp[] = [{ op: "move", uid: uidOf("tuid-c"), parent_uid: uidOf("tuid-a"), order_idx: orderIdxOf(0) }];
  const inverse = invertOps(before, PAGE, ops)!;
  const after = applyOps(applyOps(before, ops, PAGE), inverse, PAGE);
  // c is back at top level after b (order_idx values may differ; shape matters)
  expect(after.map((n) => n.uid)).toEqual(["tuid-a", "tuid-b", "tuid-c"]);
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

const flat = (...tags: string[]) =>
  tags.map((u, i) => block(u, u, { order_idx: orderIdxOf(i) }));

it("round-trips a move up: the swapped sibling took the old key", () => {
  // moveBlockUp b1: the move lands on b0's key, shifting b0 into b1's old one
  const before = flat("tuid-b0", "tuid-b1");
  const ops: BlockOp[] = [{ op: "move", uid: uidOf("tuid-b1"), parent_uid: null, order_idx: orderIdxOf(0) }];
  expect(shape(roundTrip(before, ops))).toEqual(["tuid-b0", "tuid-b1"]);
});

it("round-trips a move up inside a parent", () => {
  const before = [block("tuid-p", "p", { order_idx: orderIdxOf(0), children: flat("tuid-c0", "tuid-c1", "tuid-c2") })];
  const ops: BlockOp[] = [{ op: "move", uid: uidOf("tuid-c2"), parent_uid: uidOf("tuid-p"), order_idx: orderIdxOf(1) }];
  expect(shape(roundTrip(before, ops))).toEqual(["tuid-p", ["tuid-c0", "tuid-c1", "tuid-c2"]]);
});

it("round-trips a selection move down (its next sibling moves up)", () => {
  // moveSelectionDown [b0, b1]: b2 moves to the run's first key
  const before = flat("tuid-b0", "tuid-b1", "tuid-b2", "tuid-b3");
  const ops: BlockOp[] = [{ op: "move", uid: uidOf("tuid-b2"), parent_uid: null, order_idx: orderIdxOf(0) }];
  expect(shape(roundTrip(before, ops))).toEqual(["tuid-b0", "tuid-b1", "tuid-b2", "tuid-b3"]);
});

it("round-trips a selection move up (its previous sibling moves down)", () => {
  // moveSelectionUp [b2, b3]: b1 moves past the run's last block
  const before = flat("tuid-b0", "tuid-b1", "tuid-b2", "tuid-b3");
  const ops: BlockOp[] = [{ op: "move", uid: uidOf("tuid-b1"), parent_uid: null, order_idx: orderIdxOf(4) }];
  expect(shape(roundTrip(before, ops))).toEqual(["tuid-b0", "tuid-b1", "tuid-b2", "tuid-b3"]);
});

it("round-trips a multi-block drop up within a parent", () => {
  // moveBlocksTo [c2, c3] before c0: groupMoveOps, one op per block, and the
  // second op shifts the siblings the first inverse will be placed among
  const before = [block("tuid-p", "p", {
    order_idx: orderIdxOf(0),
    children: flat("tuid-c0", "tuid-c1", "tuid-c2", "tuid-c3") })];
  const ops: BlockOp[] = [
    { op: "move", uid: uidOf("tuid-c2"), parent_uid: uidOf("tuid-p"), order_idx: orderIdxOf(0) },
    { op: "move", uid: uidOf("tuid-c3"), parent_uid: uidOf("tuid-p"), order_idx: orderIdxOf(1) },
  ];
  expect(shape(roundTrip(before, ops))).toEqual(["tuid-p", ["tuid-c0", "tuid-c1", "tuid-c2", "tuid-c3"]]);
});

it("round-trips a multi-block move into another parent's middle", () => {
  // the source keeps its keys; the destination's siblings are shifted twice
  const before = [
    block("tuid-p", "p", { order_idx: orderIdxOf(0), children: flat("tuid-c0", "tuid-c1") }),
    block("tuid-x", "x", { order_idx: orderIdxOf(1) }),
    block("tuid-y", "y", { order_idx: orderIdxOf(2) }),
  ];
  const ops: BlockOp[] = [
    { op: "move", uid: uidOf("tuid-x"), parent_uid: uidOf("tuid-p"), order_idx: orderIdxOf(1) },
    { op: "move", uid: uidOf("tuid-y"), parent_uid: uidOf("tuid-p"), order_idx: orderIdxOf(2) },
  ];
  expect(shape(roundTrip(before, ops))).toEqual(["tuid-p", ["tuid-c0", "tuid-c1"], "tuid-x", "tuid-y"]);
});

it("round-trips a delete whose old previous sibling a later op shifted", () => {
  const before = flat("tuid-b0", "tuid-b1", "tuid-b2");
  const ops: BlockOp[] = [
    { op: "delete", uid: uidOf("tuid-b1") },
    { op: "move", uid: uidOf("tuid-b2"), parent_uid: null, order_idx: orderIdxOf(0) },
  ];
  expect(shape(roundTrip(before, ops))).toEqual(["tuid-b0", "tuid-b1", "tuid-b2"]);
});

it("round-trips a batch of many creates, moves and deletes", () => {
  // paste-sized: every op shifts keys the inverses after it are planned on
  const before = [
    ...flat("tuid-b0", "tuid-b1", "tuid-b2", "tuid-b3", "tuid-b4", "tuid-b5", "tuid-b6", "tuid-b7"),
    block("tuid-p", "p", { order_idx: orderIdxOf(8), children: flat("tuid-c0", "tuid-c1", "tuid-c2") }),
  ];
  const ops: BlockOp[] = [];
  for (let i = 0; i < 40; i++) {
    ops.push({ op: "create", uid: uidOf(`tuid-n${i}`), page_title: PAGE,
               parent_uid: i % 2 === 0 ? null : uidOf("tuid-p"),
               order_idx: orderIdxOf(i % 5), text: `n${i}` });
  }
  ops.push(...moveTo("tuid-b7", 0), ...moveTo("tuid-b6", 1),
           { op: "move", uid: uidOf("tuid-b3"), parent_uid: uidOf("tuid-p"), order_idx: orderIdxOf(0) },
           { op: "delete", uid: uidOf("tuid-b1") }, { op: "delete", uid: uidOf("tuid-c1") },
           ...moveTo("tuid-b5", 2));
  expect(shape(roundTrip(before, ops))).toEqual(shape(before));
});

it("undoes a deleted subtree's children in order after another entry shifted its siblings", () => {
  let tree = [
    block("tuid-a", "a", { order_idx: orderIdxOf(0) }),
    block("tuid-b", "b", { order_idx: orderIdxOf(1), children: flat("tuid-c0", "tuid-c1", "tuid-c2") }),
    block("tuid-d", "d", { order_idx: orderIdxOf(2) }),
  ];
  const deleted = record(tree, [{ op: "delete", uid: uidOf("tuid-b") }]);
  tree = applyOps(tree, deleted.ops, PAGE);                 // [a, d]
  const moved = record(tree, moveTo("tuid-d", 0));          // [d, a]
  tree = applyOps(tree, moved.ops, PAGE);
  tree = replay(tree, moved, "undo");
  tree = replay(tree, deleted, "undo");
  expect(shape(tree)).toEqual(["tuid-a", "tuid-b", ["tuid-c0", "tuid-c1", "tuid-c2"], "tuid-d"]);
});

it("round-trips a move whose old slot sat in a key gap", () => {
  // sparse keys: b's old key is still free between its neighbours
  const before = [block("tuid-a", "a", { order_idx: orderIdxOf(0) }),
                  block("tuid-b", "b", { order_idx: orderIdxOf(5) }),
                  block("tuid-c", "c", { order_idx: orderIdxOf(9) })];
  const ops: BlockOp[] = [{ op: "move", uid: uidOf("tuid-b"), parent_uid: null, order_idx: orderIdxOf(0) }];
  expect(shape(roundTrip(before, ops))).toEqual(["tuid-a", "tuid-b", "tuid-c"]);
});

it("inverts delete into creates for the whole subtree plus collapsed restore", () => {
  const ops: BlockOp[] = [{ op: "delete", uid: uidOf("tuid-b") }];
  expect(invertOps(tree(), PAGE, ops)).toEqual([
    { op: "create", uid: "tuid-b", page_title: PAGE, parent_uid: null,
      order_idx: 1, text: "beta", heading: null, view_type: null },
    { op: "create", uid: "tuid-b1", page_title: PAGE, parent_uid: "tuid-b",
      order_idx: 0, text: "child", heading: 2, view_type: null },
    { op: "set_collapsed", uid: "tuid-b", collapsed: true },
  ]);
});

it("inverts set_heading and set_view_type to old values", () => {
  expect(invertOps(tree(), PAGE, [{ op: "set_heading", uid: uidOf("tuid-b1"), heading: null }]))
    .toEqual([{ op: "set_heading", uid: "tuid-b1", heading: 2 }]);
  expect(invertOps(tree(), PAGE, [{ op: "set_view_type", uid: uidOf("tuid-a"), view_type: "numbered" }]))
    .toEqual([{ op: "set_view_type", uid: "tuid-a", view_type: "document" }]);
});

it("drops set_collapsed from inverses (collapse-only batch inverts to [])", () => {
  expect(invertOps(tree(), PAGE, [{ op: "set_collapsed", uid: uidOf("tuid-b"), collapsed: false }]))
    .toEqual([]);
});

it("drops set_collapsed riders but keeps the rest (indent auto-expand)", () => {
  const ops: BlockOp[] = [
    { op: "set_collapsed", uid: uidOf("tuid-b"), collapsed: false },
    { op: "move", uid: uidOf("tuid-c"), parent_uid: uidOf("tuid-b"), order_idx: orderIdxOf(1) },
  ];
  expect(invertOps(tree(), PAGE, ops))
    .toEqual([{ op: "move", uid: "tuid-c", parent_uid: null, order_idx: 2 }]);
});

it("reverses multi-op batches op-by-op (split: update_text + create)", () => {
  const ops: BlockOp[] = [
    { op: "update_text", uid: uidOf("tuid-a"), text: "al" },
    { op: "create", uid: uidOf("tuid-n"), page_title: PAGE, parent_uid: null,
      order_idx: orderIdxOf(1), text: "pha" },
  ];
  expect(invertOps(tree(), PAGE, ops)).toEqual([
    { op: "delete", uid: "tuid-n" },
    { op: "update_text", uid: "tuid-a", text: "alpha" },
  ]);
});

it("simulates sequential ops against the evolving tree", () => {
  // second op edits the block the first op created
  const ops: BlockOp[] = [
    { op: "create", uid: uidOf("tuid-n"), page_title: PAGE, parent_uid: null,
      order_idx: orderIdxOf(3), text: "first" },
    { op: "update_text", uid: uidOf("tuid-n"), text: "second" },
  ];
  expect(invertOps(tree(), PAGE, ops)).toEqual([
    { op: "update_text", uid: "tuid-n", text: "first" },
    { op: "delete", uid: "tuid-n" },
  ]);
});

it("keeps a deleted subtree's create group in parent-first order when reversed", () => {
  const ops: BlockOp[] = [
    { op: "update_text", uid: uidOf("tuid-a"), text: "x" },
    { op: "delete", uid: uidOf("tuid-b") },
  ];
  const inverse = invertOps(tree(), PAGE, ops)!;
  // group order reversed, but within the delete-inverse parents precede
  // children
  expect(inverse.map((o) => o.op))
    .toEqual(["create", "create", "set_collapsed", "update_text"]);
  expect(inverse[0]).toMatchObject({ uid: "tuid-b" });
  expect(inverse[1]).toMatchObject({ uid: "tuid-b1", parent_uid: "tuid-b" });
});

it("returns null for ops on unknown blocks (cross-page move source)", () => {
  expect(invertOps(tree(), PAGE, [{ op: "move", uid: uidOf("tuid-zz"), parent_uid: null,
                                    order_idx: orderIdxOf(0) }])).toBeNull();
  expect(invertOps(tree(), PAGE, [{ op: "update_text", uid: uidOf("tuid-zz"), text: "x" }]))
    .toBeNull();
});

it("returns null for a move that leaves this page", () => {
  expect(invertOps(tree(), PAGE, [{ op: "move", uid: uidOf("tuid-c"), parent_uid: null,
                                    order_idx: orderIdxOf(0), page_title: "Other" }]))
    .toBeNull();
});

it("returns [] for create_page (additive, nothing to undo)", () => {
  expect(invertOps(tree(), PAGE, [{ op: "create_page", page_title: "New" }]))
    .toEqual([]);
});

// Records and replays the way useOutline.run and undoManager.dispatch do:
// anchors are read at record time, and the replayed batch is re-keyed against
// whatever tree it is replayed onto.
const record = (pre: BlockNode[], ops: BlockOp[]): HistoryEntry => {
  const inverse = invertOps(pre, PAGE, ops)!;
  return { pageTitle: PAGE, ops, inverse,
           anchors: historyAnchors(pre, PAGE, ops, inverse),
           freshAssets: [],
           focusBefore: null, focusAfter: null };
};
const replay = (tree: BlockNode[], e: HistoryEntry,
                direction: "undo" | "redo"): BlockNode[] => {
  const batch = direction === "undo" ? e.inverse : e.ops;
  const anchors = direction === "undo" ? e.anchors.inverse : e.anchors.ops;
  return applyOps(tree, resolveAnchors(tree, PAGE, batch, anchors), PAGE);
};
const moveTo = (u: string, slot: number): BlockOp[] =>
  [{ op: "move", uid: uidOf(u), parent_uid: null, order_idx: orderIdxOf(slot) }];

it("anchors each placement on the sibling it lands in front of", () => {
  const before = flat("tuid-b0", "tuid-b1", "tuid-b2");
  const ops: BlockOp[] = [
    { op: "update_text", uid: uidOf("tuid-b0"), text: "x" },
    ...moveTo("tuid-b2", 0),
  ];
  const anchors = historyAnchors(before, PAGE, ops, invertOps(before, PAGE, ops)!);
  // forward: b2 lands in front of b0; undo: b2 goes back last
  expect(anchors.ops).toEqual([null, { before: "tuid-b0" }]);
  expect(anchors.inverse).toEqual([{ before: null }, null]);
});

it("undoes two moves up in a row though the first undo shifted keys", () => {
  let tree = flat("tuid-b0", "tuid-b1", "tuid-b2");
  const first = record(tree, moveTo("tuid-b1", 0));     // [b1, b0, b2]
  tree = applyOps(tree, first.ops, PAGE);
  const second = record(tree, moveTo("tuid-b2", tree[1].order_idx)); // [b1, b2, b0]
  tree = applyOps(tree, second.ops, PAGE);
  tree = replay(tree, second, "undo");
  expect(shape(tree)).toEqual(["tuid-b1", "tuid-b0", "tuid-b2"]);
  tree = replay(tree, first, "undo");
  expect(shape(tree)).toEqual(["tuid-b0", "tuid-b1", "tuid-b2"]);
});

it("redoes a move down after its undo shifted the keys it was planned on", () => {
  // moveBlockDown b0 of dense [b0, b1, b2]: lands on b2's key
  let tree = flat("tuid-b0", "tuid-b1", "tuid-b2");
  const e = record(tree, moveTo("tuid-b0", 2));
  tree = applyOps(tree, e.ops, PAGE);
  tree = replay(tree, e, "undo");
  expect(shape(tree)).toEqual(["tuid-b0", "tuid-b1", "tuid-b2"]);
  tree = replay(tree, e, "redo");
  expect(shape(tree)).toEqual(["tuid-b1", "tuid-b0", "tuid-b2"]);
});

it("redoes a selection move up after its undo", () => {
  // moveSelectionUp [b2, b3]: b1 moves past the run's last block
  let tree = flat("tuid-b0", "tuid-b1", "tuid-b2", "tuid-b3");
  const e = record(tree, moveTo("tuid-b1", 4));
  tree = applyOps(tree, e.ops, PAGE);
  expect(shape(tree)).toEqual(["tuid-b0", "tuid-b2", "tuid-b3", "tuid-b1"]);
  tree = replay(tree, e, "undo");
  expect(shape(tree)).toEqual(["tuid-b0", "tuid-b1", "tuid-b2", "tuid-b3"]);
  tree = replay(tree, e, "redo");
  expect(shape(tree)).toEqual(["tuid-b0", "tuid-b2", "tuid-b3", "tuid-b1"]);
});

it("redoes a multi-block drop down after its undo", () => {
  // moveBlocksTo [b0, b1] after b3: groupMoveOps at the end of the list
  let tree = flat("tuid-b0", "tuid-b1", "tuid-b2", "tuid-b3");
  const e = record(tree, [...moveTo("tuid-b0", 4), ...moveTo("tuid-b1", 5)]);
  tree = applyOps(tree, e.ops, PAGE);
  expect(shape(tree)).toEqual(["tuid-b2", "tuid-b3", "tuid-b0", "tuid-b1"]);
  tree = replay(tree, e, "undo");
  expect(shape(tree)).toEqual(["tuid-b0", "tuid-b1", "tuid-b2", "tuid-b3"]);
  tree = replay(tree, e, "redo");
  expect(shape(tree)).toEqual(["tuid-b2", "tuid-b3", "tuid-b0", "tuid-b1"]);
});

it("undo lands in front of its old next sibling after another device inserted", () => {
  let tree = flat("tuid-a", "tuid-b", "tuid-c", "tuid-d");
  const e = record(tree, moveTo("tuid-b", 3));           // [a, c, b, d]
  tree = applyOps(tree, e.ops, PAGE);
  // another device inserts x in front of c, shifting every key from c's on
  const remote: BlockOp[] = [{ op: "create", uid: uidOf("tuid-x"), page_title: PAGE,
                               parent_uid: null, order_idx: tree[1].order_idx,
                               text: "x" }];
  tree = applyOps(tree, remote, PAGE);
  expect(shape(tree)).toEqual(["tuid-a", "tuid-x", "tuid-c", "tuid-b", "tuid-d"]);
  tree = replay(tree, e, "undo");
  expect(shape(tree)).toEqual(["tuid-a", "tuid-x", "tuid-b", "tuid-c", "tuid-d"]);
});

it("keeps the recorded key when the anchor has left the parent", () => {
  const live = [block("tuid-a", "a", { order_idx: orderIdxOf(0) }),
                block("tuid-p", "p", { order_idx: orderIdxOf(1),
                                  children: [block("tuid-c", "c", { order_idx: orderIdxOf(0) })] }),
                block("tuid-m", "m", { order_idx: orderIdxOf(2) })];
  // anchored in front of c, which another device moved under p
  const ops = moveTo("tuid-m", 1);
  expect(resolveAnchors(live, PAGE, ops, [{ before: uidOf("tuid-c") }])).toEqual(ops);
  // and in front of a block that no longer exists
  expect(resolveAnchors(live, PAGE, ops, [{ before: uidOf("tuid-gone") }])).toEqual(ops);
});

it("keeps the recorded key when it already lands at the anchor", () => {
  const live = [block("tuid-a", "a", { order_idx: orderIdxOf(0) }),
                block("tuid-c", "c", { order_idx: orderIdxOf(4) }),
                block("tuid-m", "m", { order_idx: orderIdxOf(9) })];
  const ops = moveTo("tuid-m", 2);
  expect(resolveAnchors(live, PAGE, ops, [{ before: uidOf("tuid-c") }])).toEqual(ops);
});

it("re-keys a placement whose recorded key no longer lands at its anchor", () => {
  const live = [block("tuid-a", "a", { order_idx: orderIdxOf(3) }),
                block("tuid-c", "c", { order_idx: orderIdxOf(4) }),
                block("tuid-m", "m", { order_idx: orderIdxOf(9) })];
  expect(resolveAnchors(live, PAGE, moveTo("tuid-m", 1), [{ before: uidOf("tuid-c") }]))
    .toEqual(moveTo("tuid-m", 4));
  expect(resolveAnchors(live, PAGE, moveTo("tuid-a", 0), [{ before: null }]))
    .toEqual(moveTo("tuid-a", 10));
});

const entry = (n: number): HistoryEntry => ({
  pageTitle: PAGE,
  ops: [{ op: "update_text", uid: uidOf("tuid-a"), text: `v${n}` }],
  inverse: [{ op: "update_text", uid: uidOf("tuid-a"), text: `v${n - 1}` }],
  anchors: { ops: [null], inverse: [null] },
  freshAssets: [],
  focusBefore: null,
  focusAfter: null,
});

const rec = (s: HistoryState, e: HistoryEntry): HistoryState =>
  recordEntry(s, e);

it("undo pops LIFO and moves the entry to the redo stack", () => {
  let s = rec(rec(emptyHistory(), entry(1)), entry(2));
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
  let s = rec(emptyHistory(), entry(1));
  s = takeUndo(s).state;
  expect(s.redo).toHaveLength(1);
  s = rec(s, entry(2));
  expect(s.redo).toHaveLength(0);
});

it("caps the undo stack, evicting the oldest", () => {
  let s = emptyHistory();
  for (let i = 0; i < HISTORY_CAP + 5; i++) s = rec(s, entry(i));
  expect(s.undo).toHaveLength(HISTORY_CAP);
  expect(s.undo[0]).toEqual(entry(5)); // oldest five evicted
});

const FRESH = [shaOf("a".repeat(64))];

it("undoing an entry with freshAssets clears redo, earlier redo entries included", () => {
  let s = rec(rec(rec(emptyHistory(), entry(1)), { ...entry(2), freshAssets: FRESH }), entry(3));
  s = takeUndo(s).state; // entry 3 -> redo
  expect(s.redo).toHaveLength(1);
  const u = takeUndo(s);
  expect(u.entry!.freshAssets).toEqual(FRESH);
  expect(u.state.redo).toEqual([]);
  expect(takeRedo(u.state).entry).toBeNull();
});

it("undoing an entry without freshAssets leaves redo intact", () => {
  let s = rec(rec(emptyHistory(), entry(1)), entry(2));
  s = takeUndo(takeUndo(s).state).state;
  expect(s.redo).toHaveLength(2);
});

it("edits before an undone upload stay undoable, then redoable", () => {
  const drop = { ...entry(2), freshAssets: FRESH };
  const s = rec(rec(emptyHistory(), entry(1)), drop);
  const u1 = takeUndo(s);
  expect(u1.entry).toBe(drop);
  const u2 = takeUndo(u1.state);
  expect(u2.entry).toEqual(entry(1));
  const r = takeRedo(u2.state);
  expect(r.entry).toEqual(entry(1));
  expect(takeRedo(r.state).entry).toBeNull();
});
