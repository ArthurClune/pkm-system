import { describe, expect, it } from "vitest";
import type { BlockOp } from "../api/ops";
import { block } from "../test-helpers";
import { applyOps } from "./tree";
import { invertOps } from "./history";

const PAGE = "Test Page";

const tree = () => [
  block("a", "alpha", { order_idx: 0 }),
  block("b", "beta", {
    order_idx: 1,
    collapsed: true,
    children: [block("b1", "child", { order_idx: 0, heading: 2 })],
  }),
  block("c", "gamma", { order_idx: 2 }),
];

it("inverts create to delete", () => {
  const ops: BlockOp[] = [{ op: "create", uid: "n", page_title: PAGE,
                            parent_uid: null, order_idx: 3, text: "new" }];
  expect(invertOps(tree(), PAGE, ops)).toEqual([{ op: "delete", uid: "n" }]);
});

it("inverts update_text to the pre-op text", () => {
  const ops: BlockOp[] = [{ op: "update_text", uid: "a", text: "changed" }];
  expect(invertOps(tree(), PAGE, ops))
    .toEqual([{ op: "update_text", uid: "a", text: "alpha" }]);
});

it("inverts move back to the old parent and order_idx", () => {
  const ops: BlockOp[] = [{ op: "move", uid: "c", parent_uid: "a", order_idx: 0 }];
  expect(invertOps(tree(), PAGE, ops))
    .toEqual([{ op: "move", uid: "c", parent_uid: null, order_idx: 2 }]);
});

it("round-trips a move: apply ops then inverse restores the shape", () => {
  const before = tree();
  const ops: BlockOp[] = [{ op: "move", uid: "c", parent_uid: "a", order_idx: 0 }];
  const inverse = invertOps(before, PAGE, ops)!;
  const after = applyOps(applyOps(before, ops, PAGE), inverse, PAGE);
  // c is back at top level after b (order_idx values may differ; shape matters)
  expect(after.map((n) => n.uid)).toEqual(["a", "b", "c"]);
  expect(after[0].children).toEqual([]);
});

it("inverts delete into creates for the whole subtree plus collapsed restore", () => {
  const ops: BlockOp[] = [{ op: "delete", uid: "b" }];
  expect(invertOps(tree(), PAGE, ops)).toEqual([
    { op: "create", uid: "b", page_title: PAGE, parent_uid: null,
      order_idx: 1, text: "beta", heading: null, view_type: null },
    { op: "create", uid: "b1", page_title: PAGE, parent_uid: "b",
      order_idx: 0, text: "child", heading: 2, view_type: null },
    { op: "set_collapsed", uid: "b", collapsed: true },
  ]);
});

it("inverts set_heading and set_view_type to old values", () => {
  expect(invertOps(tree(), PAGE, [{ op: "set_heading", uid: "b1", heading: null }]))
    .toEqual([{ op: "set_heading", uid: "b1", heading: 2 }]);
  expect(invertOps(tree(), PAGE, [{ op: "set_view_type", uid: "a", view_type: "numbered" }]))
    .toEqual([{ op: "set_view_type", uid: "a", view_type: "document" }]);
});

it("drops set_collapsed from inverses (collapse-only batch inverts to [])", () => {
  expect(invertOps(tree(), PAGE, [{ op: "set_collapsed", uid: "b", collapsed: false }]))
    .toEqual([]);
});

it("drops set_collapsed riders but keeps the rest (indent auto-expand)", () => {
  const ops: BlockOp[] = [
    { op: "set_collapsed", uid: "b", collapsed: false },
    { op: "move", uid: "c", parent_uid: "b", order_idx: 1 },
  ];
  expect(invertOps(tree(), PAGE, ops))
    .toEqual([{ op: "move", uid: "c", parent_uid: null, order_idx: 2 }]);
});

it("reverses multi-op batches op-by-op (split: update_text + create)", () => {
  const ops: BlockOp[] = [
    { op: "update_text", uid: "a", text: "al" },
    { op: "create", uid: "n", page_title: PAGE, parent_uid: null,
      order_idx: 1, text: "pha" },
  ];
  expect(invertOps(tree(), PAGE, ops)).toEqual([
    { op: "delete", uid: "n" },
    { op: "update_text", uid: "a", text: "alpha" },
  ]);
});

it("simulates sequential ops against the evolving tree", () => {
  // second op edits the block the first op created
  const ops: BlockOp[] = [
    { op: "create", uid: "n", page_title: PAGE, parent_uid: null,
      order_idx: 3, text: "first" },
    { op: "update_text", uid: "n", text: "second" },
  ];
  expect(invertOps(tree(), PAGE, ops)).toEqual([
    { op: "update_text", uid: "n", text: "first" },
    { op: "delete", uid: "n" },
  ]);
});

it("keeps a deleted subtree's create group in parent-first order when reversed", () => {
  const ops: BlockOp[] = [
    { op: "update_text", uid: "a", text: "x" },
    { op: "delete", uid: "b" },
  ];
  const inverse = invertOps(tree(), PAGE, ops)!;
  // group order reversed, but within the delete-inverse parents precede children
  expect(inverse.map((o) => o.op))
    .toEqual(["create", "create", "set_collapsed", "update_text"]);
  expect(inverse[0]).toMatchObject({ uid: "b" });
  expect(inverse[1]).toMatchObject({ uid: "b1", parent_uid: "b" });
});

it("returns null for ops on unknown blocks (cross-page move source)", () => {
  expect(invertOps(tree(), PAGE, [{ op: "move", uid: "zz", parent_uid: null,
                                    order_idx: 0 }])).toBeNull();
  expect(invertOps(tree(), PAGE, [{ op: "update_text", uid: "zz", text: "x" }]))
    .toBeNull();
});

it("returns null for a move that leaves this page", () => {
  expect(invertOps(tree(), PAGE, [{ op: "move", uid: "c", parent_uid: null,
                                    order_idx: 0, page_title: "Other" }]))
    .toBeNull();
});

it("returns [] for create_page (additive, nothing to undo)", () => {
  expect(invertOps(tree(), PAGE, [{ op: "create_page", page_title: "New" }]))
    .toEqual([]);
});
