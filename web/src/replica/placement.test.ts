import { describe, expect, test } from "vitest";
import type { CreateOp, MoveOp } from "../api/ops";
import { type PlacementFacts, placementFor } from "./placement";
import { orderIdxOf, pageIdOf, uidOf, rawTitleOf } from "../test-helpers";

const create = (over: Partial<CreateOp> = {}): CreateOp => ({
  op: "create", uid: uidOf("tuid-n1"), page_title: rawTitleOf("Home"), parent_uid: uidOf("tuid-p1"),
  order_idx: orderIdxOf(0), text: "typed", ...over,
});

const move = (over: Partial<MoveOp> = {}): MoveOp => ({
  op: "move", uid: uidOf("tuid-b1"), parent_uid: uidOf("tuid-p1"), order_idx: orderIdxOf(0), ...over,
});

const facts = (over: Partial<PlacementFacts> = {}): PlacementFacts => ({
  block: null, parent: null, parentChain: [], titlePageId: null, ...over,
});

describe("skip", () => {
  test("a create under a missing parent is skipped", () => {
    expect(placementFor(create(), facts())).toEqual({ kind: "skip" });
  });

  test("a move of a missing block is skipped", () => {
    expect(placementFor(move(), facts({ parent: { page_id: pageIdOf(1) } })))
      .toEqual({ kind: "skip" });
  });

  test("a move under its own descendant is skipped", () => {
    expect(placementFor(move(), facts({
      block: { page_id: pageIdOf(1), parent_uid: null, order_idx: orderIdxOf(0) },
      parent: { page_id: pageIdOf(1) },
      parentChain: [uidOf("tuid-p1"), uidOf("tuid-b1")],
    }))).toEqual({ kind: "skip" });
  });
});

describe("create", () => {

  test("a create under a live parent lands on the parent's page", () => {
    expect(placementFor(create(), facts({ parent: { page_id: pageIdOf(2) } })))
      .toEqual({ kind: "place", page: { id: 2 }, parentUid: "tuid-p1",
                 orderIdx: 0, repage: false });
  });

  test("a top-level create lands on its title page", () => {
    expect(placementFor(create({ parent_uid: null, order_idx: orderIdxOf(3) }), facts()))
      .toEqual({ kind: "place", page: { title: "Home" }, parentUid: null,
                 orderIdx: 3, repage: false });
  });

  test("a create onto an existing uid is placed, so the INSERT fails", () => {
    expect(placementFor(create(), facts({
      block: { page_id: pageIdOf(1), parent_uid: uidOf("tuid-p1"), order_idx: orderIdxOf(0) },
      parent: { page_id: pageIdOf(1) },
    }))).toEqual({ kind: "place", page: { id: 1 }, parentUid: "tuid-p1",
                          orderIdx: 0, repage: false });
  });
});

describe("move", () => {
  const block = { page_id: pageIdOf(1), parent_uid: uidOf("tuid-p1"), order_idx: orderIdxOf(0) };

  // a replay runs over the rewound replica, so nothing is ever kept in place
  test("a move already at its target is placed again", () => {
    expect(placementFor(move(), facts({ block, parent: { page_id: pageIdOf(1) } })))
      .toEqual({ kind: "place", page: { id: 1 }, parentUid: "tuid-p1",
                 orderIdx: 0, repage: false });
  });

  test("a move under a parent on another page re-pages the block", () => {
    expect(placementFor(move({ page_title: rawTitleOf("Gone") }),
                        facts({ block, parent: { page_id: pageIdOf(2) } })))
      .toEqual({ kind: "place", page: { id: 2 }, parentUid: "tuid-p1",
                 orderIdx: 0, repage: true });
  });

  test("a top-level move to a title with no page yet creates it and re-pages", () => {
    expect(placementFor(move({ parent_uid: null, page_title: rawTitleOf("New") }),
                        facts({ block })))
      .toEqual({ kind: "place", page: { title: "New" }, parentUid: null,
                 orderIdx: 0, repage: true });
  });

  test("a top-level move to a title on the block's own page does not re-page", () => {
    expect(placementFor(move({ parent_uid: null, page_title: rawTitleOf("Home") }),
                        facts({ block, titlePageId: pageIdOf(1) })))
      .toEqual({ kind: "place", page: { title: "Home" }, parentUid: null,
                 orderIdx: 0, repage: false });
  });

  test("a top-level move to another existing title page re-pages", () => {
    expect(placementFor(move({ parent_uid: null, page_title: rawTitleOf("Other") }),
                        facts({ block, titlePageId: pageIdOf(2) })))
      .toEqual({ kind: "place", page: { title: "Other" }, parentUid: null,
                 orderIdx: 0, repage: true });
  });

  test("a move with no parent and no title stays on the block's page", () => {
    expect(placementFor(move({ parent_uid: null, order_idx: orderIdxOf(4) }),
                        facts({ block })))
      .toEqual({ kind: "place", page: { id: 1 }, parentUid: null,
                 orderIdx: 4, repage: false });
  });
});
