import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BlockUid, OrderIdx } from "../../api/brands";
import type { BlockNode } from "../../api/payloads";
import { allowedDepths, dropRows } from "../../outline/dnd";
import { emptyHistory } from "../../outline/history";
import { findNode } from "../../outline/tree";
import { forestArb, PAGE_TITLE, renderForest, sequenceArb, treeArb, type Command,
         type IndentStyle } from "./arbitraries";
import { readingRows } from "./reading";
import { runSequence } from "./run";

const node = (uid: string, order: number, over: Partial<BlockNode> = {},
              children: BlockNode[] = []): BlockNode => ({
  uid: uid as BlockUid, text: uid, heading: null, view_type: null, collapsed: false,
  order_idx: order as OrderIdx, created_at: null, updated_at: null, children,
  ...over,
});

const flat = (): BlockNode[] => ["a", "b", "c", "d"].map((uid, i) => node(uid, i));
const uid = (s: string) => s as BlockUid;
const textOf = (blocks: BlockNode[], u: string) => findNode(blocks, uid(u))?.text;

describe("runSequence", () => {
  it("a type command is held as a draft and flushed by the next command", () => {
    const run = runSequence(flat(), [
      { kind: "type", row: 1, text: "zz" },
      { kind: "indent", row: 1 },
    ]);
    const [typed, indent] = run.steps;
    expect(textOf(typed.after, "b")).toBe("zz");
    expect(typed.ops).toEqual([{ op: "update_text", uid: "b", text: "zz" }]);
    expect(textOf(indent.base, "b")).toBe("zz");
    expect(indent.ops.every((op) => op.op !== "update_text")).toBe(true);
    expect(run.history.undo).toHaveLength(1);
    expect(run.history.undo[0].ops[0]).toEqual({ op: "update_text", uid: "b", text: "zz" });
    expect(run.history.undo[0].ops.length).toBeGreaterThan(1);
  });

  it("a command on another block flushes the draft as its own entry first", () => {
    const run = runSequence(flat(), [
      { kind: "type", row: 0, text: "zz" },
      { kind: "indent", row: 1 },
    ]);
    expect(textOf(run.steps[1].base, "a")).toBe("zz");
    expect(run.history.undo.map((e) => e.ops)).toEqual([
      [{ op: "update_text", uid: "a", text: "zz" }],
      run.steps[1].ops,
    ]);
  });

  it("a selection command flushes the draft as its own entry first", () => {
    const run = runSequence(flat(), [
      { kind: "type", row: 1, text: "zz" },
      { kind: "indentSel", row: 1, span: 0 },
    ]);
    expect(run.history.undo.map((e) => e.ops)).toEqual([
      [{ op: "update_text", uid: "b", text: "zz" }],
      run.steps[1].ops,
    ]);
  });

  it("undo flushes a pending draft as its own entry first", () => {
    const run = runSequence(flat(), [
      { kind: "type", row: 0, text: "zz" },
      { kind: "undo" },
    ]);
    const undo = run.steps[1];
    expect(textOf(undo.base, "a")).toBe("zz");
    expect(textOf(undo.after, "a")).toBe("a");
    expect(undo.undo?.expectedRows).toEqual(readingRows(flat()));
    expect(run.history.undo).toEqual([]);
    expect(run.history.redo).toHaveLength(1);
    expect(run.history.redo[0].ops).toEqual([{ op: "update_text", uid: "a", text: "zz" }]);
    expect(textOf(run.end, "a")).toBe("a");
  });

  it("typing a block back to its original text records nothing", () => {
    const run = runSequence(flat(), [
      { kind: "type", row: 0, text: "zz" },
      { kind: "type", row: 0, text: "a" },
      { kind: "indent", row: 0 },
    ]);
    expect(run.steps[1].ops).toEqual([{ op: "update_text", uid: "a", text: "a" }]);
    expect(run.history).toEqual(emptyHistory());
  });

  it("redo replays the entry and expects the rows it left", () => {
    const run = runSequence(flat(), [
      { kind: "indent", row: 1 },
      { kind: "undo" },
      { kind: "redo" },
    ]);
    const [indent, undo, redo] = run.steps;
    expect(undo.undo?.expectedRows).toEqual(readingRows(indent.base));
    expect(redo.undo?.expectedRows).toEqual(readingRows(indent.after));
    expect(readingRows(redo.after)).toEqual(readingRows(indent.after));
    expect(run.history.undo).toHaveLength(1);
    expect(run.history.redo).toEqual([]);
  });

  it("an undo with nothing to undo leaves the tree", () => {
    const run = runSequence(flat(), [{ kind: "undo" }, { kind: "redo" }]);
    for (const step of run.steps) {
      expect(step.after).toEqual(step.base);
      expect(step.undo?.expectedRows).toEqual(readingRows(step.base));
    }
  });

  it("a no-op command records nothing", () => {
    const run = runSequence(flat(), [{ kind: "indent", row: 0 }]);
    expect(run.steps[0].ops).toEqual([]);
    expect(run.steps[0].inverse).toEqual([]);
    expect(run.steps[0].after).toEqual(run.steps[0].base);
    expect(run.history).toEqual(emptyHistory());
  });

  it("a collapse-only command records nothing", () => {
    const start = [node("a", 0, {}, [node("b", 0)]), node("c", 1)];
    const run = runSequence(start, [{ kind: "collapse", row: 0, value: true }]);
    expect(run.steps[0].ops).toEqual([{ op: "set_collapsed", uid: "a", collapsed: true }]);
    expect(run.steps[0].inverse).toEqual([]);
    expect(findNode(run.end, uid("a"))?.collapsed).toBe(true);
    expect(run.history).toEqual(emptyHistory());
  });

  it("a command with no visible row is skipped", () => {
    const run = runSequence([], [{ kind: "indent", row: 3 }]);
    expect(run.steps[0].resolved).toBeNull();
    expect(run.steps[0].ops).toEqual([]);
  });

  it("selection commands resolve to visible-row ranges", () => {
    const uids = (command: Command) => {
      const r = runSequence(flat(), [command]).steps[0].resolved;
      return r && "uids" in r ? r.uids : null;
    };
    expect(runSequence(flat(), [{ kind: "selUp", row: 1, span: 2 }]).steps[0].resolved)
      .toEqual({ kind: "selUp", uids: ["b", "c", "d"] });
    expect(uids({ kind: "selUp", row: 1, span: 40 })).toEqual(["b", "c", "d"]);
    expect(uids({ kind: "deleteSel", row: 6, span: 0 })).toEqual(["c"]);
  });

  it("split resolves its caret as a fraction of the text and mints a fresh uid", () => {
    const start = [node("a", 0, { text: "hello" })];
    const run = runSequence(start, [
      { kind: "split", row: 0, caret: 40 },
      { kind: "split", row: 0, caret: 101 },
    ]);
    expect(run.steps[0].resolved).toEqual({ kind: "split", uid: "a", caret: 2, fresh: "n0" });
    expect(run.steps[1].resolved).toEqual({ kind: "split", uid: "a", caret: 0, fresh: "n1" });
  });

  it("drop resolves depth from allowedDepths", () => {
    const dropArb = fc.record({
      kind: fc.constant("drop" as const), row: fc.nat(), span: fc.nat(3),
      boundary: fc.nat(), depth: fc.nat(),
    });
    fc.assert(fc.property(treeArb, dropArb, (start, command) => {
      const [step] = runSequence(start, [command]).steps;
      const r = step.resolved;
      if (r?.kind !== "drop") return false;
      const rows = dropRows(step.base, { uid: r.uids[0], pageTitle: PAGE_TITLE, uids: r.uids },
                            PAGE_TITLE);
      return r.position.boundary <= rows.length
        && allowedDepths(rows, r.position.boundary).includes(r.position.depth);
    }));
  });

  it("paste only runs when the text is an outline paste", () => {
    const pasteArb = fc.record({
      kind: fc.constant("paste" as const), row: fc.nat(), from: fc.nat(), to: fc.nat(),
      forest: forestArb, style: fc.constantFrom<IndentStyle>("two", "four", "tab", "bullet"),
    });
    fc.assert(fc.property(treeArb, pasteArb, (start, command: Command & { kind: "paste" }) => {
      const [step] = runSequence(start, [command]).steps;
      const r = step.resolved;
      if (r?.kind !== "paste") return false;
      const count = (ns: typeof command.forest): number =>
        ns.reduce((n, c) => n + 1 + count(c.children), 0);
      const text = findNode(step.base, r.uid)?.text ?? "";
      return r.text === renderForest(command.forest, command.style)
        && r.fresh.length === count(command.forest) - 1
        && r.fresh.every((u) => findNode(step.after, u) !== null)
        && 0 <= r.from && r.from <= r.to && r.to <= text.length;
    }));
  });

  it("runs any generated sequence, one step per command", () => {
    fc.assert(fc.property(sequenceArb, ({ start, commands }) => {
      const run = runSequence(start, commands);
      return run.steps.length === commands.length
        && run.steps.every((s, i) => s.command === commands[i]);
    }), { numRuns: 300 });
  });
});
