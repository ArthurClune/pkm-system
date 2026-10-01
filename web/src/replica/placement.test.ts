import { describe, expect, test } from "vitest";
import type { CreateOp, MoveOp } from "../api/ops";
import { type PlacementFacts, placementFor } from "./placement";
import { ord, pageId, uid } from "../test-helpers";

const create = (over: Partial<CreateOp> = {}): CreateOp => ({
  op: "create", uid: uid("n1"), page_title: "Home", parent_uid: uid("p1"),
  order_idx: ord(0), text: "typed", ...over,
});

const move = (over: Partial<MoveOp> = {}): MoveOp => ({
  op: "move", uid: uid("b1"), parent_uid: uid("p1"), order_idx: ord(0), ...over,
});

const facts = (over: Partial<PlacementFacts> = {}): PlacementFacts => ({
  block: null, parent: null, parentChain: [], titlePageId: null, ...over,
});

describe("skip", () => {
  test("a create under a missing parent is skipped", () => {
    expect(placementFor(create(), facts(), false)).toEqual({ kind: "skip" });
  });

  test("a move of a missing block is skipped", () => {
    expect(placementFor(move(), facts({ parent: { page_id: pageId(1) } }), false))
      .toEqual({ kind: "skip" });
  });

  test("a move under its own descendant is skipped", () => {
    expect(placementFor(move(), facts({
      block: { page_id: pageId(1), parent_uid: null, order_idx: ord(0) },
      parent: { page_id: pageId(1) },
      parentChain: [uid("p1"), uid("b1")],
    }), false)).toEqual({ kind: "skip" });
  });
});

describe("create", () => {
  test("a replayed create whose row exists keeps it where it is", () => {
    expect(placementFor(create(), facts({
      block: { page_id: pageId(1), parent_uid: uid("p1"), order_idx: ord(0) },
      parent: { page_id: pageId(1) },
    }), true)).toEqual({ kind: "keep", repageTo: null });
  });

  test("a replayed create under a parent on another page follows the parent's page", () => {
    expect(placementFor(create(), facts({
      block: { page_id: pageId(1), parent_uid: uid("p1"), order_idx: ord(0) },
      parent: { page_id: pageId(2) },
    }), true)).toEqual({ kind: "keep", repageTo: 2 });
  });

  test("a replayed create a later move took to another parent is not re-paged", () => {
    expect(placementFor(create(), facts({
      block: { page_id: pageId(1), parent_uid: null, order_idx: ord(2) },
      parent: { page_id: pageId(2) },
    }), true)).toEqual({ kind: "keep", repageTo: null });
  });

  test("a create under a live parent lands on the parent's page", () => {
    expect(placementFor(create(), facts({ parent: { page_id: pageId(2) } }), false))
      .toEqual({ kind: "place", page: { id: 2 }, parentUid: "p1",
                 orderIdx: 0, repage: false });
  });

  test("a top-level create lands on its title page", () => {
    expect(placementFor(create({ parent_uid: null, order_idx: ord(3) }), facts(), false))
      .toEqual({ kind: "place", page: { title: "Home" }, parentUid: null,
                 orderIdx: 3, repage: false });
  });

  test("a create onto an existing uid outside a replay is still placed, so the INSERT fails", () => {
    expect(placementFor(create(), facts({
      block: { page_id: pageId(1), parent_uid: uid("p1"), order_idx: ord(0) },
      parent: { page_id: pageId(1) },
    }), false)).toEqual({ kind: "place", page: { id: 1 }, parentUid: "p1",
                          orderIdx: 0, repage: false });
  });
});

describe("move", () => {
  const block = { page_id: pageId(1), parent_uid: uid("p1"), order_idx: ord(0) };

  test("a replayed move already at its target keeps its slot", () => {
    expect(placementFor(move(), facts({ block, parent: { page_id: pageId(1) } }), true))
      .toEqual({ kind: "keep", repageTo: null });
  });

  test("the same move outside a replay is placed again", () => {
    expect(placementFor(move(), facts({ block, parent: { page_id: pageId(1) } }), false))
      .toEqual({ kind: "place", page: { id: 1 }, parentUid: "p1",
                 orderIdx: 0, repage: false });
  });

  test("a replayed move whose order_idx differs is placed", () => {
    expect(placementFor(move({ order_idx: ord(1) }),
                        facts({ block, parent: { page_id: pageId(1) } }), true))
      .toEqual({ kind: "place", page: { id: 1 }, parentUid: "p1",
                 orderIdx: 1, repage: false });
  });

  test("a move under a parent on another page re-pages the block", () => {
    expect(placementFor(move({ page_title: "Gone" }),
                        facts({ block, parent: { page_id: pageId(2) } }), false))
      .toEqual({ kind: "place", page: { id: 2 }, parentUid: "p1",
                 orderIdx: 0, repage: true });
  });

  test("a top-level move to a title with no page yet creates it and re-pages", () => {
    expect(placementFor(move({ parent_uid: null, page_title: "New" }),
                        facts({ block }), true))
      .toEqual({ kind: "place", page: { title: "New" }, parentUid: null,
                 orderIdx: 0, repage: true });
  });

  test("a top-level move to a title on the block's own page does not re-page", () => {
    expect(placementFor(move({ parent_uid: null, page_title: "Home" }),
                        facts({ block, titlePageId: pageId(1) }), false))
      .toEqual({ kind: "place", page: { title: "Home" }, parentUid: null,
                 orderIdx: 0, repage: false });
  });

  test("a top-level move to another existing title page re-pages", () => {
    expect(placementFor(move({ parent_uid: null, page_title: "Other" }),
                        facts({ block, titlePageId: pageId(2) }), false))
      .toEqual({ kind: "place", page: { title: "Other" }, parentUid: null,
                 orderIdx: 0, repage: true });
  });

  test("a replayed top-level move already on its title page keeps its slot", () => {
    expect(placementFor(move({ parent_uid: null, order_idx: ord(3), page_title: "Home" }),
                        facts({ block: { page_id: pageId(1), parent_uid: null, order_idx: ord(3) },
                                titlePageId: pageId(1) }), true))
      .toEqual({ kind: "keep", repageTo: null });
  });

  test("a move with no parent and no title stays on the block's page", () => {
    expect(placementFor(move({ parent_uid: null, order_idx: ord(4) }),
                        facts({ block }), false))
      .toEqual({ kind: "place", page: { id: 1 }, parentUid: null,
                 orderIdx: 4, repage: false });
  });

  test("a replayed move with no parent and no title already in place keeps its slot", () => {
    expect(placementFor(move({ parent_uid: null, order_idx: ord(4) }),
                        facts({ block: { page_id: pageId(1), parent_uid: null, order_idx: ord(4) } }),
                        true))
      .toEqual({ kind: "keep", repageTo: null });
  });
});
