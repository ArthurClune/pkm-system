import { describe, expect, it } from "vitest";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { MAX_BLOCK_TEXT_CHARS } from "../grammar/textLimits";
import { sha256Hex } from "../replica/sha256";
import { BATCH_TOO_LARGE_NOTICE,
         MAX_OPS_PER_BATCH } from "../sync/batchLimits";
import { block, canonicalTitleOf, orderIdxOf, shaOf,
         uidOf } from "../test-helpers";
import { planCommand, planReplay } from "./command";
import { DEPTH_NOTICE, MAX_OUTLINE_DEPTH } from "./depthCap";
import { backspaceAtStart, deleteSelection, indentBlock, setCollapsed,
         setHeading, type EditResult } from "./edits";
import { historyAnchors, invertOps } from "./history";
import { applyOps } from "./tree";

const P = canonicalTitleOf("Page");
const A = uidOf("tuid-a");
const B = uidOf("tuid-b");
const C = uidOf("tuid-c");

const abc = (aText = "old"): BlockNode[] => [
  block("tuid-a", aText, { order_idx: orderIdxOf(0) }),
  block("tuid-b", "two", { order_idx: orderIdxOf(1) }),
  block("tuid-c", "three", { order_idx: orderIdxOf(2) }),
];

const noop = (b: BlockNode[]): EditResult => ({ blocks: b, ops: [], focus: null });

/** A command whose ops are `ops`, applied to the tree it runs on. */
const plain = (ops: BlockOp[]) => (b: BlockNode[]): EditResult =>
  ({ blocks: applyOps(b, ops, P), ops, focus: null });

const typed = (uid = A, text = "typed", base = "old") => ({ uid, text, base });

describe("planCommand", () => {
  it("a draft and a command ship as one batch, text ops first, stamped against pre", () => {
    // A remote edit landed under the draft: the tree holds "remote".
    const pre = abc("remote");
    const plan = planCommand(pre, typed(), (b) => backspaceAtStart(b, P, B), P, null, []);
    expect(plan.verdict).toEqual({ kind: "applied" });
    expect(plan.wireOps[0]).toEqual({
      op: "update_text", uid: A, text: "typed",
      base_text_hash: sha256Hex("old"), page_title: P,
    });
    expect(plan.wireOps.slice(1).map((op) => op.op)).toEqual(plan.ops.map((op) => op.op));
    // The merge into a is stamped over the text the draft left there.
    expect(plan.wireOps[1]).toMatchObject({
      op: "update_text", uid: A, text: "typedtwo", base_text_hash: sha256Hex("typed"),
    });
    expect(plan.next).toEqual(applyOps(pre, plan.wireOps, P));
    expect(plan.focus).toEqual({ uid: A, cursor: 5 });
  });

  it("records the batch unstamped, anchored and inverted against pre", () => {
    const pre = abc();
    const plan = planCommand(pre, typed(), (b) => indentBlock(b, P, B), P, null, []);
    const recorded = [{ op: "update_text", uid: A, text: "typed" }, ...plan.ops];
    expect(plan.entry?.ops).toEqual(recorded);
    expect(plan.entry?.ops[0]).not.toHaveProperty("base_text_hash");
    const inverse = invertOps(pre, P, plan.entry!.ops)!;
    expect(plan.inverse).toEqual(inverse);
    expect(plan.entry?.inverse).toEqual(inverse);
    expect(plan.entry?.anchors).toEqual(historyAnchors(pre, P, plan.entry!.ops, inverse));
    expect(plan.base).toEqual(applyOps(pre, plan.wireOps.slice(0, 1), P));
  });

  it("a refused command still ships and records the draft's text ops", () => {
    const pre = abc();
    const tooLong = plain([{ op: "update_text", uid: B,
                             text: "x".repeat(MAX_BLOCK_TEXT_CHARS + 1) }]);
    const plan = planCommand(pre, typed(), tooLong, P, null, []);
    expect(plan.verdict).toMatchObject({ kind: "refused" });
    expect(plan.ops).toEqual([]);
    expect(plan.next).toBe(plan.base);
    expect(plan.next[0].text).toBe("typed");
    expect(plan.wireOps).toEqual([{ op: "update_text", uid: A, text: "typed",
                                    base_text_hash: sha256Hex("old"), page_title: P }]);
    expect(plan.entry?.ops).toEqual([{ op: "update_text", uid: A, text: "typed" }]);
    expect(plan.focus).toBeNull();
  });

  it("the draft's text ops count toward a refused batch's size", () => {
    const flips = (b: BlockNode[]): EditResult => {
      const ops: BlockOp[] = Array.from({ length: MAX_OPS_PER_BATCH }, (_, i) =>
        ({ op: "set_collapsed", uid: B, collapsed: i % 2 === 0 }));
      return { blocks: applyOps(b, ops, P), ops, focus: null };
    };
    expect(planCommand(abc(), null, flips, P, null, []).verdict)
      .toEqual({ kind: "applied" });
    expect(planCommand(abc(), typed(), flips, P, null, []).verdict)
      .toEqual({ kind: "refused", notice: BATCH_TOO_LARGE_NOTICE });
  });

  it("a draft whose block is not in pre ships but is not recorded", () => {
    const gone = uidOf("tuid-gone");
    const plan = planCommand(abc(), typed(gone), (b) => setHeading(b, P, B, 2), P, null, []);
    expect(plan.wireOps).toMatchObject([
      { op: "update_text", uid: gone }, { op: "set_heading", uid: B },
    ]);
    expect(plan.entry?.ops).toEqual([{ op: "set_heading", uid: B, heading: 2 }]);
  });

  it("a draft on a block the command deletes is recorded and inverted", () => {
    const pre = abc();
    const plan = planCommand(pre, typed(B, "typed", "two"),
                             (b) => deleteSelection(b, P, [B]), P, null, []);
    expect(plan.entry?.ops).toMatchObject([
      { op: "update_text", uid: B, text: "typed" }, { op: "delete", uid: B },
    ]);
    const undone = applyOps(plan.next, plan.entry!.inverse, P);
    expect(undone.map((n) => [n.uid, n.text])).toEqual([[A, "old"], [B, "two"], [C, "three"]]);
  });

  it("a command with no ops is not judged", () => {
    // Judged, a ref to this title would be refused; run() refuses such a
    // draft before planning, so a flush on its own ships what it gets.
    const plan = planCommand(abc(), typed(A, "see [[a#b]]"), noop, P, null, []);
    expect(plan.verdict).toEqual({ kind: "none" });
    expect(plan.wireOps).toHaveLength(1);
    expect(plan.entry?.ops).toEqual([{ op: "update_text", uid: A, text: "see [[a#b]]" }]);
  });

  it("nothing ships: no wire ops, an empty inverse and no entry", () => {
    const pre = abc();
    const plan = planCommand(pre, null, noop, P, { uid: A, cursor: 1 }, []);
    expect(plan).toEqual({
      verdict: { kind: "none" }, base: pre, ops: [], next: pre, wireOps: [],
      inverse: [], entry: null, focus: null,
    });
    expect(plan.next).toBe(pre);
  });

  it("a collapse ships but records no entry: its inverse is empty", () => {
    const plan = planCommand(abc(), null, (b) => setCollapsed(b, P, A, true), P, null, []);
    expect(plan.wireOps).toHaveLength(1);
    expect(plan.inverse).toEqual([]);
    expect(plan.entry).toBeNull();
  });

  it("a batch whose inverse is null records no entry", () => {
    const away = plain([{ op: "move", uid: B, parent_uid: null, order_idx: orderIdxOf(0),
                          page_title: canonicalTitleOf("Elsewhere") }]);
    const plan = planCommand(abc(), null, away, P, null, []);
    expect(plan.verdict).toEqual({ kind: "applied" });
    expect(plan.wireOps).toHaveLength(1);
    expect(plan.inverse).toBeNull();
    expect(plan.entry).toBeNull();
  });

  it("the entry's focusAfter falls back to focusBefore", () => {
    const before = { uid: B, cursor: 2 };
    const plan = planCommand(abc(), null, (b) => setHeading(b, P, B, 1), P, before, []);
    expect(plan.focus).toBeNull();
    expect(plan.entry?.focusBefore).toBe(before);
    expect(plan.entry?.focusAfter).toBe(before);
  });

  it("freshAssets ride on the entry", () => {
    const fresh = [shaOf("a".repeat(64))];
    const plan = planCommand(abc(), null, (b) => setHeading(b, P, B, 1), P, null, fresh);
    expect(plan.entry?.freshAssets).toBe(fresh);
  });
});

function chain(depth: number): BlockNode[] {
  let node = block("tuid-leaf", "x");
  for (let i = 1; i < depth; i++) node = block(`tuid-n${i}`, "x", { children: [node] });
  return [node];
}

describe("planReplay", () => {
  it("planReplay re-keys against the live tree before stamping", () => {
    // Recorded as "create in front of b", at the key b held then; b has
    // since moved to key 5, behind a new block at key 1.
    const recorded: BlockOp[] = [
      { op: "create", uid: uidOf("tuid-new"), page_title: P, parent_uid: null,
        order_idx: orderIdxOf(1), text: "" },
      { op: "update_text", uid: B, text: "edited" },
    ];
    const pre = [block("tuid-a", "old", { order_idx: orderIdxOf(0) }),
                 block("tuid-b", "two", { order_idx: orderIdxOf(1) })];
    const anchors = historyAnchors(pre, P, recorded, []).ops;
    const live = [block("tuid-a", "old", { order_idx: orderIdxOf(0) }),
                  block("tuid-x", "other", { order_idx: orderIdxOf(1) }),
                  block("tuid-b", "now", { order_idx: orderIdxOf(5) })];
    const plan = planReplay(live, recorded, anchors, P);
    expect(plan.refusal).toBeNull();
    expect(plan.resolved[0]).toMatchObject({ op: "create", order_idx: 5 });
    expect(plan.next?.map((n) => n.uid)).toEqual([A, uidOf("tuid-x"), uidOf("tuid-new"), B]);
    expect(plan.wireOps[0]).toEqual(plan.resolved[0]);
    expect(plan.wireOps[1]).toEqual({ op: "update_text", uid: B, text: "edited",
                                      base_text_hash: sha256Hex("now"), page_title: P });
  });

  it("planReplay with no tree ships the batch unstamped and judges no depth", () => {
    const deep: BlockOp[] = [{ op: "create", uid: uidOf("tuid-deeper"), page_title: P,
                               parent_uid: uidOf("tuid-leaf"), order_idx: orderIdxOf(0),
                               text: "" },
                             { op: "update_text", uid: B, text: "edited" }];
    const anchors = deep.map(() => null);
    expect(planReplay(chain(MAX_OUTLINE_DEPTH), deep, anchors, P).refusal)
      .toBe(DEPTH_NOTICE);
    const plan = planReplay(null, deep, anchors, P);
    expect(plan).toEqual({ refusal: null, resolved: deep, next: null, wireOps: deep });
  });

  it("a refused replay has no wire ops", () => {
    const tooLong: BlockOp[] = [{ op: "update_text", uid: B,
                                  text: "x".repeat(MAX_BLOCK_TEXT_CHARS + 1) }];
    const live = planReplay(abc(), tooLong, [null], P);
    expect(live.refusal).not.toBeNull();
    expect(live.wireOps).toEqual([]);
    const unread = planReplay(null, tooLong, [null], P);
    expect(unread.refusal).toBe(live.refusal);
    expect(unread.wireOps).toEqual([]);
  });
});
