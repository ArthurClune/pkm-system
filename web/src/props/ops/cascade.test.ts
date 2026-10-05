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

// The first run's shape: a pending batch moves opsb02 (Ops Three) under
// opsb16 (Ops Two) twice; another device deletes opsb16; the head window's
// tombstone cascades over the optimistically moved opsb02, while the server
// skips both moves and keeps opsb02 (with a child here) on Ops Three.
const moves = [{ uid: "opsb02", parent: "opsb16" }, { uid: "opsb02", parent: "opsb16" }];
const tombstoned = new Set(["opsb16"]);
const replayed = graph([nb("opsb03", "Ops Two", null, 0), nb("opsb06", "Ops Three", null, 0)]);
const server = graph([
  nb("opsb03", "Ops Two", null, 0), nb("opsb06", "Ops Three", null, 0),
  nb("opsb02", "Ops Three", null, 1), nb("opsb04", "Ops Three", "opsb02", 0),
]);

describe("cascadeExclusions", () => {
  it("sets aside the kept block and its subtree", () => {
    expect([...cascadeExclusions(moves, tombstoned, replayed, server)].sort())
      .toEqual(["opsb02", "opsb04"]);
  });

  it("sets nothing aside when the window tombstoned another block", () => {
    expect(cascadeExclusions(moves, new Set(["opsb03"]), replayed, server).size).toBe(0);
  });

  it("sets nothing aside when the replayed replica still holds the block", () => {
    const kept = graph([...replayed.blocks, nb("opsb02", "Ops Two", null, 1)]);
    expect(cascadeExclusions(moves, tombstoned, kept, server).size).toBe(0);
  });

  it("sets nothing aside when the server lost the block too", () => {
    const gone = graph(server.blocks.filter((b) => b.uid !== "opsb02" && b.uid !== "opsb04"));
    expect(cascadeExclusions(moves, tombstoned, replayed, gone).size).toBe(0);
  });

  it("ignores top-level moves", () => {
    expect(cascadeExclusions([{ uid: "opsb02", parent: null }], tombstoned, replayed, server).size)
      .toBe(0);
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
  const removed = cascadeRemoved(new Set(["opsb28"]), before);
  const replayedHere = graph([nb("opsb16", "Outline Props", null, 0)]);
  const serverHere = graph([nb("opsb16", "Outline Props", null, 0),
                            nb("opsb05", "Ops Three", null, 0)]);

  it("counts the tombstoned block's descendants as removed", () => {
    expect([...removed].sort()).toEqual(["opsb05", "opsb28", "opsc00"]);
  });

  it("sets aside the kept block moved under the removed create", () => {
    expect([...cascadeExclusions([{ uid: "opsb05", parent: "opsc00" }], removed,
                                 replayedHere, serverHere)]).toEqual(["opsb05"]);
  });

  it("sets nothing aside for a move under a block outside the removed subtree", () => {
    expect(cascadeExclusions([{ uid: "opsb05", parent: "opsb16" }], removed,
                             replayedHere, serverHere).size).toBe(0);
  });
});

describe("cascadeRemoved", () => {
  it("is the tombstoned uids when the replica holds nothing under them", () => {
    expect([...cascadeRemoved(new Set(["opsb16", "opsx99"]), replayed)].sort())
      .toEqual(["opsb16", "opsx99"]);
  });
});

describe("withoutBlocks", () => {
  it("drops exactly the named blocks", () => {
    expect(withoutBlocks(server, new Set(["opsb02", "opsb04"])).blocks.map((b) => b.uid))
      .toEqual(["opsb03", "opsb06"]);
  });
});
