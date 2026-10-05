import { describe, expect, it } from "vitest";
import type { NormalBlock, NormalGraph } from "../sync/normalise";
import { cascadeExclusions, withoutBlocks } from "./cascade";

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

describe("withoutBlocks", () => {
  it("drops exactly the named blocks", () => {
    expect(withoutBlocks(server, new Set(["opsb02", "opsb04"])).blocks.map((b) => b.uid))
      .toEqual(["opsb03", "opsb06"]);
  });
});
