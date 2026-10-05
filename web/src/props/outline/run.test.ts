import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BlockUid, OrderIdx } from "../../api/brands";
import type { BlockNode } from "../../api/payloads";
import { allowedDepths, dropRows } from "../../outline/dnd";
import { emptyHistory } from "../../outline/history";
import { applyOps, blocksEqual, findNode } from "../../outline/tree";
import { forestArb, PAGE_TITLE, renderForest, sequenceArb, treeArb, type Command,
         type IndentStyle } from "./arbitraries";
import { readingRows } from "./reading";
import { REAL, runSequence } from "./run";

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

  it("a folded command that is itself a no-op records a text-only entry", () => {
    const run = runSequence(flat(), [
      { kind: "type", row: 0, text: "zz" },
      { kind: "indent", row: 0 },
    ]);
    const indent = run.steps[1];
    expect(indent.ops).toEqual([]);
    expect(indent.after).toEqual(indent.base);
    expect(textOf(indent.after, "a")).toBe("zz");
    expect(run.history.undo.map((e) => e.ops)).toEqual([
      [{ op: "update_text", uid: "a", text: "zz" }],
    ]);
  });

  it("a batch with no inverse is not recorded", () => {
    const run = runSequence(flat(), [{ kind: "indent", row: 1 }],
                            { ...REAL, invertOps: () => null });
    expect(run.steps[0].ops.length).toBeGreaterThan(0);
    expect(run.steps[0].inverse).toBeNull();
    expect(run.history).toEqual(emptyHistory());
  });

  it("a drop that resolves to no move still flushes the draft", () => {
    const run = runSequence(flat(), [
      { kind: "type", row: 0, text: "zz" },
      { kind: "drop", row: 0, span: 0, boundary: 0, depth: 0 },
    ]);
    const drop = run.steps[1];
    expect(drop.resolved?.kind).toBe("drop");
    expect(drop.ops).toEqual([]);
    expect(textOf(drop.base, "a")).toBe("zz");
    expect(run.history.undo.map((e) => e.ops)).toEqual([
      [{ op: "update_text", uid: "a", text: "zz" }],
    ]);
  });

  it("entry focus follows the gesture that ran the command", () => {
    const sel = runSequence(flat(), [
      { kind: "type", row: 0, text: "zz" },
      { kind: "indentSel", row: 1, span: 0 },
    ]);
    expect(sel.history.undo.map((e) => e.focusBefore)).toEqual([
      { uid: "a", cursor: 1 }, null,
    ]);
    const other = runSequence(flat(), [
      { kind: "type", row: 0, text: "zz" },
      { kind: "indent", row: 2 },
    ]);
    expect(other.history.undo.map((e) => e.focusBefore)).toEqual([
      { uid: "a", cursor: 1 }, { uid: "c", cursor: 1 },
    ]);
  });

  it("typing keeps the caret the block took when it was focused", () => {
    const run = runSequence(flat(), [
      { kind: "type", row: 1, text: "longtext" },
      { kind: "type", row: 1, text: "x" },
      { kind: "indent", row: 1 },
    ]);
    expect(run.steps.slice(0, 2).map((s) => s.focus)).toEqual([null, null]);
    expect(run.history.undo.map((e) => e.focusBefore)).toEqual([{ uid: "b", cursor: 1 }]);
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

  it("an undo or redo step reports the batch it applied, placements re-keyed", () => {
    const run = runSequence(flat(), [
      { kind: "moveDown", row: 1 },
      { kind: "undo" },
      { kind: "redo" },
    ]);
    const [entry] = run.history.undo;
    const redo = run.steps[2];
    // Undo shifted the keys the move was planned on, so redo re-keys it.
    expect(redo.ops).not.toEqual(entry.ops);
    for (const step of run.steps.slice(1)) {
      expect(blocksEqual(applyOps(step.base, step.ops, PAGE_TITLE), step.after)).toBe(true);
    }
  });

  it("newest holds the rows after the newest entry, wherever it sits", () => {
    expect(runSequence(flat(), []).newest).toEqual(readingRows(flat()));
    const undone = runSequence(flat(), [
      { kind: "indent", row: 1 },
      { kind: "indent", row: 2 },
      { kind: "undo" },
    ]);
    expect(undone.history.redo).toHaveLength(1);
    expect(undone.newest).toEqual(readingRows(undone.steps[1].after));
    const typed = runSequence(flat(), [{ kind: "indent", row: 1 }, { kind: "type", row: 2, text: "zz" }]);
    expect(typed.newest).toEqual(readingRows(typed.end));
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
        && readingRows(step.after).every((row) =>
          findNode(step.base, row.uid) !== null || r.fresh.includes(row.uid))
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

  describe("wire batches", () => {
    it("mintPrefix names the fresh uid a split mints", () => {
      const run = runSequence(flat(), [{ kind: "split", row: 1, caret: 50 }], { mintPrefix: "opsn" });
      expect(run.steps[0].resolved).toMatchObject({ kind: "split", fresh: "opsn0" });
    });

    it("a draft folded into indent goes out as one batch, stamped", () => {
      const run = runSequence(flat(), [
        { kind: "type", row: 1, text: "zz" },
        { kind: "indent", row: 1 },
      ]);
      expect(run.batches).toHaveLength(1);
      const [ops] = [run.batches[0].ops];
      expect(ops.map((o) => o.op)).toEqual(["update_text", "move"]);
      expect(ops[0]).toHaveProperty("base_text_hash");
      expect(run.batches[0].after).toEqual(run.end);
    });

    it("a trailing typed draft is the final batch", () => {
      const run = runSequence(flat(), [{ kind: "type", row: 1, text: "zz" }]);
      expect(run.batches).toHaveLength(1);
      expect(run.batches[0].pre).toEqual(flat());
      expect(textOf(run.batches[0].after, "b")).toBe("zz");
    });

    it("an undo is a batch whose after is the earlier tree", () => {
      const run = runSequence(flat(), [{ kind: "moveDown", row: 0 }, { kind: "undo" }]);
      expect(run.batches).toHaveLength(2);
      expect(readingRows(run.batches[1].after)).toEqual(readingRows(flat()));
    });

    it("commands that emit nothing send nothing", () => {
      expect(runSequence(flat(), [{ kind: "undo" }]).batches).toEqual([]);
      expect(runSequence(flat(), [{ kind: "indent", row: 0 }]).batches).toEqual([]);
    });

    it("every batch's ops take pre to after", () => {
      fc.assert(fc.property(sequenceArb, (seq) => {
        const run = runSequence(seq.start, seq.commands);
        return run.batches.every((b) => blocksEqual(applyOps(b.pre, b.ops, PAGE_TITLE), b.after));
      }), { numRuns: 200 });
    });
  });
});
