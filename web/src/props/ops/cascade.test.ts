import { describe, expect, it } from "vitest";
import type { NormalBlock, NormalGraph } from "../sync/normalise";
import { cascadeExclusions, cascadeRemoved, withoutBlocks } from "./cascade";

const nb = (uid: string, page: string, parent_uid: string | null,
            order_idx: number): NormalBlock => ({
  uid, page, parent_uid, order_idx, text: "", heading: null, collapsed: 1,
  view_type: null, refs: [],
});
const graph = (blocks: NormalBlock[]): NormalGraph => ({
  pages: [...new Set(blocks.map((b) => b.page))].sort(), blocks,
});
const sorted = (s: Set<string>): string[] => [...s].sort();

// Run 1's shape: a pending batch moves opsb02 (Ops Three, with child opsb04)
// under opsb16 (Ops Two) twice; another device deletes opsb16; the head
// window's tombstone cascades over the optimistically moved opsb02, while
// the server skips both moves and keeps opsb02 and opsb04 on Ops Three.
describe("a cascade over a block moved under the tombstoned block", () => {
  const before = graph([
    nb("opsb03", "Ops Two", null, 0), nb("opsb16", "Ops Two", null, 1),
    nb("opsb02", "Ops Two", "opsb16", 0), nb("opsb04", "Ops Two", "opsb02", 0),
    nb("opsb06", "Ops Three", null, 0),
  ]);
  const removed = cascadeRemoved(new Set(["opsb16"]), before, []);
  const moves = [{ uid: "opsb02", parent: "opsb16", index: 0 },
                 { uid: "opsb02", parent: "opsb16", index: 1 }];
  const replayed = graph([nb("opsb03", "Ops Two", null, 0), nb("opsb06", "Ops Three", null, 0)]);
  const server = graph([
    nb("opsb03", "Ops Two", null, 0), nb("opsb06", "Ops Three", null, 0),
    nb("opsb02", "Ops Three", null, 1), nb("opsb04", "Ops Three", "opsb02", 0),
  ]);
  const bothSkipped = new Set([0, 1]);

  it("removes the tombstoned block and everything under it", () => {
    expect(sorted(removed)).toEqual(["opsb02", "opsb04", "opsb16"]);
  });

  it("sets aside the kept block and its subtree", () => {
    expect(sorted(cascadeExclusions(moves, bothSkipped, removed, replayed, server)))
      .toEqual(["opsb02", "opsb04"]);
  });

  it("sets nothing aside when the window tombstoned another block", () => {
    const other = cascadeRemoved(new Set(["opsb03"]), before, []);
    expect(cascadeExclusions(moves, bothSkipped, other, replayed, server).size).toBe(0);
  });

  it("sets nothing aside when the replayed replica still holds the block", () => {
    const kept = graph([...replayed.blocks, nb("opsb02", "Ops Three", null, 1)]);
    expect(cascadeExclusions(moves, bothSkipped, removed, kept, server).size).toBe(0);
  });

  it("sets nothing aside when the server lost the block too", () => {
    const gone = graph(server.blocks.filter((b) => b.uid !== "opsb02" && b.uid !== "opsb04"));
    expect(cascadeExclusions(moves, bothSkipped, removed, replayed, gone).size).toBe(0);
  });

  it("sets nothing aside when the ack skipped neither move", () => {
    expect(cascadeExclusions(moves, new Set(), removed, replayed, server).size).toBe(0);
  });

  it("ignores top-level moves", () => {
    expect(cascadeExclusions([{ uid: "opsb02", parent: null, index: 0 }], bothSkipped,
                             removed, replayed, server).size).toBe(0);
  });
});

// Run 5's shape, one level deeper: the batch creates opsc00 under opsb28
// and moves opsb05 (Ops Three) under opsc00; another device deletes
// opsb28. The tombstone of opsb28 cascades over the pending create and so
// over opsb05, while the server skips both ops and keeps opsb05.
describe("a cascade through a pending create", () => {
  const before = graph([
    nb("opsb16", "Outline Props", null, 0), nb("opsb28", "Outline Props", null, 3),
    nb("opsc00", "Outline Props", "opsb28", 0), nb("opsb05", "Outline Props", "opsc00", 0),
  ]);
  const removed = cascadeRemoved(new Set(["opsb28"]), before, []);
  const replayed = graph([nb("opsb16", "Outline Props", null, 0)]);
  const server = graph([nb("opsb16", "Outline Props", null, 0),
                        nb("opsb05", "Ops Three", null, 0)]);

  it("counts the tombstoned block's descendants as removed", () => {
    expect(sorted(removed)).toEqual(["opsb05", "opsb28", "opsc00"]);
  });

  it("sets aside the kept block moved under the removed create", () => {
    expect(sorted(cascadeExclusions([{ uid: "opsb05", parent: "opsc00", index: 1 }],
                                    new Set([0, 1]), removed, replayed, server)))
      .toEqual(["opsb05"]);
  });
});

describe("cases the exclusion must leave to the checks", () => {
  // B = [move X under P, move X under R]; O deletes P. X never sits under P
  // when the cascade runs, so a replay that loses X is a replay bug.
  it("a move a later move of the same block superseded", () => {
    const before = graph([
      nb("P", "Ops Two", null, 0), nb("R", "Ops Two", null, 1), nb("X", "Ops Two", "R", 0),
    ]);
    const removed = cascadeRemoved(new Set(["P"]), before, []);
    expect(sorted(removed)).toEqual(["P"]);
    const replayed = graph([nb("R", "Ops Two", null, 0)]);
    const server = graph([nb("R", "Ops Two", null, 0), nb("X", "Ops Two", "R", 0)]);
    expect(cascadeExclusions([{ uid: "X", parent: "P", index: 0 },
                              { uid: "X", parent: "R", index: 1 }],
                             new Set([0]), removed, replayed, server).size).toBe(0);
  });

  // O = [move Q (P's child) to the top level, delete P]; B moves X under Q.
  // The window's upserts move Q out before its tombstone of P cascades, so
  // the cascade takes P alone.
  it("a descendant the window moved out before its tombstone", () => {
    const before = graph([
      nb("P", "Ops Two", null, 0), nb("Q", "Ops Two", "P", 0), nb("X", "Ops Two", "Q", 0),
    ]);
    const removed = cascadeRemoved(new Set(["P"]), before, [{ uid: "Q", parent_uid: null }]);
    expect(sorted(removed)).toEqual(["P"]);
    const replayed = graph([nb("Q", "Ops Two", null, 0)]);
    const server = graph([nb("Q", "Ops Two", null, 0), nb("X", "Ops Two", "Q", 0)]);
    expect(cascadeExclusions([{ uid: "X", parent: "Q", index: 0 }], new Set([0]),
                             removed, replayed, server).size).toBe(0);
  });

  // B = [create C at the top, move C under P, move X under C]; O deletes P.
  // The server skips C's move but applies X's move under C, so X's absence
  // from a replay is not the skip transient.
  it("a move the server applied", () => {
    const before = graph([
      nb("P", "Ops Two", null, 0), nb("C", "Ops Two", "P", 0), nb("X", "Ops Two", "C", 0),
    ]);
    const removed = cascadeRemoved(new Set(["P"]), before, []);
    expect(sorted(removed)).toEqual(["C", "P", "X"]);
    const replayed = graph([nb("C", "Ops Two", null, 0)]);
    const server = graph([nb("C", "Ops Two", null, 0), nb("X", "Ops Two", "C", 0)]);
    expect(cascadeExclusions([{ uid: "C", parent: "P", index: 1 },
                              { uid: "X", parent: "C", index: 2 }],
                             new Set([1]), removed, replayed, server).size).toBe(0);
  });
});

describe("withoutBlocks", () => {
  it("drops exactly the named blocks", () => {
    const g = graph([nb("a", "A", null, 0), nb("b", "A", null, 1), nb("c", "A", "b", 0)]);
    expect(withoutBlocks(g, new Set(["b", "c"])).blocks.map((b) => b.uid)).toEqual(["a"]);
  });
});
