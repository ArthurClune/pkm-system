import { describe, expect, test } from "vitest";
import type { BatchId } from "../../api/brands";
import { conflictLane, conflictNoise, type ConflictNoiseRun, type LaneClient,
         overwrittenTarget, textEditors } from "./conflictNoise";
import { batchIdOf, uidOf } from "../../test-helpers";

const id = (s: string): BatchId => batchIdOf(s);

const body = (ops: unknown[]): string => JSON.stringify({ client_id: "c", batch_id: "x", ops });

const setText = (rawUid: string): unknown =>
  ({ op: "update_text", uid: rawUid, text: "t" });

describe("overwrittenTarget", () => {
  test("names the block of an overwritten-by header, whatever names its page", () => {
    expect(overwrittenTarget("[[conflict]] [[Proptest]] — overwritten by ((pt_seed_1))"))
      .toBe("pt_seed_1");
    expect(overwrittenTarget("[[conflict]] `Second` — overwritten by ((pt_A_2))")).toBe("pt_A_2");
  });

  test("null for every other header", () => {
    for (const header of [
      "[[conflict]] `Second` — edit to a block the server no longer has",
      "[[conflict]] [[Proptest]] — deleted while edited elsewhere",
      "[[conflict]] [[Proptest]] — ((pt_seed_1))",
      // a page delete inlined the ref: the log, not the snapshot, keeps it
      "[[conflict]] Proptest — overwritten by seed 1",
    ]) {
      expect(overwrittenTarget(header)).toBeNull();
    }
  });
});

const run = (over: Partial<ConflictNoiseRun> = {}): ConflictNoiseRun => ({
  applied: [{ batch_id: id("a1") }, { batch_id: id("b1") }, { batch_id: id("a2") }],
  committedBy: new Map([
    ["A", new Map([[id("a1"), body([setText("pt_seed_1")])],
                   [id("a2"), body([setText("pt_seed_2"),
                                    { op: "create", uid: "pt_A_1", text: "x" }])]])],
    ["B", new Map([[id("b1"), body([setText("pt_seed_1"), { op: "delete", uid: "pt_seed_2" },
                                    { op: "move", uid: "pt_A_1" }])]])],
  ]),
  conflicts: [],
  lane: new Set(),
  ...over,
});

const overwritten = (tag: string, batch = "a2"): ConflictNoiseRun["conflicts"][number] => ({
  header_uid: uidOf("tuid-h1"), batch_id: id(batch),
  text: `[[conflict]] [[Proptest]] — overwritten by ((${tag}))`,
});

describe("textEditors", () => {
  test("only creates and update_texts write a block's text", () => {
    const editors = textEditors(run());
    expect([...editors.get(uidOf("pt_seed_1")) ?? []].sort()).toEqual(["A", "B"]);
    expect([...editors.get(uidOf("pt_seed_2")) ?? []]).toEqual(["A"]);
    expect([...editors.get(uidOf("pt_A_1")) ?? []]).toEqual(["A"]);
  });

  test("a batch that never applied edits nothing", () => {
    const editors = textEditors(run({ applied: [{ batch_id: id("a1") }] }));
    expect([...editors.get(uidOf("pt_seed_1")) ?? []]).toEqual(["A"]);
  });
});

describe("conflictLane", () => {
  // A enqueued a1, a2, a3; a2's enqueue reply was lost.
  const enqueued = new Map([["A", [id("a1"), id("a2"), id("a3")]]]);
  const client = (over: Partial<LaneClient> = {}): LaneClient => ({
    name: "A", laneBatches: [], lostReplyBatches: [id("a2")],
    undeliveredAtDeath: new Set(), ...over,
  });
  const landed = (...ids: string[]): { batch_id: BatchId }[] =>
    ids.map((s) => ({ batch_id: id(s) }));

  test("holds a lost reply whose lane copy overtook a batch a death deferred", () => {
    const c = client({ undeliveredAtDeath: new Set([id("a1"), id("a2")]) });
    expect([...conflictLane([c], landed("a2", "a1", "a3"), enqueued)]).toEqual([id("a2")]);
  });

  test("not a lost reply that landed in order", () => {
    const c = client({ undeliveredAtDeath: new Set([id("a1"), id("a2")]) });
    expect([...conflictLane([c], landed("a1", "a2", "a3"), enqueued)]).toEqual([]);
  });

  test("not a lost reply that overtook a batch no death deferred", () => {
    expect([...conflictLane([client()], landed("a2", "a1", "a3"), enqueued)]).toEqual([]);
  });

  test("not a lost reply that landed only ahead of later batches", () => {
    const c = client({ undeliveredAtDeath: new Set([id("a3")]) });
    expect([...conflictLane([c], landed("a1", "a2", "a3"), enqueued)]).toEqual([]);
  });

  test("not a lost reply ahead of a deferred batch that was itself a lane batch", () => {
    const c = client({ laneBatches: [id("a1")], undeliveredAtDeath: new Set([id("a1")]) });
    expect([...conflictLane([c], landed("a2", "a1", "a3"), enqueued)]).toEqual([id("a1")]);
  });

  test("holds every lane batch, landed or not", () => {
    const c = client({ laneBatches: [id("a3")], lostReplyBatches: [] });
    expect([...conflictLane([c], landed("a1"), enqueued)]).toEqual([id("a3")]);
  });
});

describe("conflictNoise", () => {
  test("holds for a block two clients wrote", () => {
    expect(conflictNoise(run({ conflicts: [overwritten("pt_seed_1")] }))).toEqual([]);
  });

  test("an overwritten block only one client wrote is noise", () => {
    expect(conflictNoise(run({ conflicts: [overwritten("pt_seed_2")] }))).toEqual([
      "a2 overwrote pt_seed_2 as a conflict (header tuid-h1), but only A wrote its text"]);
  });

  describe("a lane write", () => {
    // A writes pt_seed_2 from its lane (a1), then durably twice (a2, a3).
    const laneRun = (conflictBatch: string, lane = [id("a1")]): ConflictNoiseRun => run({
      applied: [{ batch_id: id("a1") }, { batch_id: id("a2") }, { batch_id: id("a3") }],
      committedBy: new Map([["A", new Map([
        [id("a1"), body([setText("pt_seed_2")])], [id("a2"), body([setText("pt_seed_2")])],
        [id("a3"), body([setText("pt_seed_2")])]])]]),
      lane: new Set(lane),
      conflicts: [overwritten("pt_seed_2", conflictBatch)],
    });

    test("excuses its client's next durable write of the block", () => {
      expect(conflictNoise(laneRun("a2"))).toEqual([]);
    });

    test("excuses nothing after that write", () => {
      expect(conflictNoise(laneRun("a3"))).toEqual([
        "a3 overwrote pt_seed_2 as a conflict (header tuid-h1), but only A wrote its text"]);
    });

    test("excuses nothing without a lane batch", () => {
      expect(conflictNoise(laneRun("a2", []))).toHaveLength(1);
    });

    test("excuses nothing when the lane wrote another block", () => {
      const r = laneRun("a2");
      const committedBy = new Map([["A", new Map([...r.committedBy.get("A") ?? [],
                                                   [id("a1"), body([setText("pt_seed_1")])]])]]);
      expect(conflictNoise({ ...r, committedBy })).toHaveLength(1);
    });
  });

  test("a header with no recorded batch is still judged", () => {
    expect(conflictNoise(run({ conflicts: [{ ...overwritten("pt_seed_2"), batch_id: null }] })))
      .toEqual(["an unrecorded batch overwrote pt_seed_2 as a conflict (header tuid-h1)," +
                " but only A wrote its text"]);
  });

  test("a block no client wrote is noise too", () => {
    expect(conflictNoise(run({ conflicts: [overwritten("pt_seed_3")] }))).toEqual([
      "a2 overwrote pt_seed_3 as a conflict (header tuid-h1), but no client wrote its text"]);
  });

  test("other headers are exempt", () => {
    expect(conflictNoise(run({ conflicts: [{
      header_uid: uidOf("tuid-h1"), batch_id: id("a2"),
      text: "[[conflict]] `Second` — edit to a block the server no longer has",
    }] }))).toEqual([]);
  });
});
