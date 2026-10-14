import { describe, expect, test } from "vitest";
import type { BatchId } from "../../api/brands";
import { conflictNoise, type ConflictNoiseRun, overwrittenTarget,
         textEditors } from "./conflictNoise";

const id = (s: string): BatchId => s as BatchId;

const body = (ops: unknown[]): string => JSON.stringify({ client_id: "c", batch_id: "x", ops });

const setText = (uid: string): unknown => ({ op: "update_text", uid, text: "t" });

describe("overwrittenTarget", () => {
  test("names the block of a check-5 header, whatever names its page", () => {
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

const overwritten = (uid: string, batch = "a2"): ConflictNoiseRun["conflicts"][number] => ({
  header_uid: "h1", batch_id: id(batch),
  text: `[[conflict]] [[Proptest]] — overwritten by ((${uid}))`,
});

describe("textEditors", () => {
  test("only creates and update_texts write a block's text", () => {
    const editors = textEditors(run());
    expect([...editors.get("pt_seed_1") ?? []].sort()).toEqual(["A", "B"]);
    expect([...editors.get("pt_seed_2") ?? []]).toEqual(["A"]);
    expect([...editors.get("pt_A_1") ?? []]).toEqual(["A"]);
  });

  test("a lane batch writes as the client's lane, not the client", () => {
    const editors = textEditors(run({ lane: new Set([id("a1")]) }));
    expect([...editors.get("pt_seed_1") ?? []].sort()).toEqual(["A's lane", "B"]);
  });

  test("a batch that never applied edits nothing", () => {
    const editors = textEditors(run({ applied: [{ batch_id: id("a1") }] }));
    expect([...editors.get("pt_seed_1") ?? []]).toEqual(["A"]);
  });
});

describe("conflictNoise", () => {
  test("holds for a block two clients wrote", () => {
    expect(conflictNoise(run({ conflicts: [overwritten("pt_seed_1")] }))).toEqual([]);
  });

  test("an overwritten block only one client wrote is noise", () => {
    expect(conflictNoise(run({ conflicts: [overwritten("pt_seed_2")] }))).toEqual([
      "a2 overwrote pt_seed_2 as a conflict (header h1), but only A wrote its text"]);
  });

  test("a client's lane and its durable edits are two writers", () => {
    const committedBy = new Map([["A", new Map([
      [id("a1"), body([setText("pt_seed_2")])], [id("a2"), body([setText("pt_seed_2")])]])]]);
    const applied = [{ batch_id: id("a1") }, { batch_id: id("a2") }];
    expect(conflictNoise(run({ applied, committedBy, conflicts: [overwritten("pt_seed_2")] })))
      .toHaveLength(1);
    expect(conflictNoise(run({ applied, committedBy, conflicts: [overwritten("pt_seed_2")],
                               lane: new Set([id("a1")]) }))).toEqual([]);
  });

  test("a block no client wrote is noise too", () => {
    expect(conflictNoise(run({ conflicts: [overwritten("pt_seed_3")] }))).toEqual([
      "a2 overwrote pt_seed_3 as a conflict (header h1), but no client wrote its text"]);
  });

  test("other headers are exempt", () => {
    expect(conflictNoise(run({ conflicts: [{
      header_uid: "h1", batch_id: id("a2"),
      text: "[[conflict]] `Second` — edit to a block the server no longer has",
    }] }))).toEqual([]);
  });
});
