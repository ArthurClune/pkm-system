import { describe, expect, it } from "vitest";
import type { BlockUid, OrderIdx } from "../../api/brands";
import type { BlockNode } from "../../api/payloads";
import type { CaretOffset } from "../../outline/keyEdits";
import { applyOps } from "../../outline/tree";
import { PAGE_TITLE, type Command } from "./arbitraries";
import { sequenceProblems, stepProblems } from "./checks";
import { readingRows } from "./reading";
import { runSequence, type Run } from "./run";

const node = (uid: string, order: number, over: Partial<BlockNode> = {},
              children: BlockNode[] = []): BlockNode => ({
  uid: uid as BlockUid, text: uid, heading: null, view_type: null, collapsed: false,
  order_idx: order as OrderIdx, created_at: null, updated_at: null, children,
  ...over,
});

const flat = (): BlockNode[] => ["a", "b", "c", "d"].map((uid, i) => node(uid, i));
const uid = (s: string) => s as BlockUid;
const caret = (n: number) => n as CaretOffset;

/** a (collapsed, holding a1), b, c: a1 is hidden. */
const folded = (): BlockNode[] => [
  node("a", 0, { collapsed: true }, [node("a1", 0)]), node("b", 1), node("c", 2),
];

const only = (property: string) => [expect.stringMatching(new RegExp(`^${property}: `))];

describe("stepProblems", () => {
  it("a clean step has no problems", () => {
    const [step] = runSequence(flat(), [{ kind: "indent", row: 1 }]).steps;
    expect(step.ops.length).toBeGreaterThan(0);
    expect(stepProblems(step)).toEqual([]);
  });

  it("a clean noop step has no problems", () => {
    const [step] = runSequence(flat(), [{ kind: "indent", row: 0 }]).steps;
    expect(step.ops).toEqual([]);
    expect(stepProblems(step)).toEqual([]);
  });

  it("a wrong tree is reported as meaning", () => {
    const [step] = runSequence(flat(), [{ kind: "indent", row: 1 }]).steps;
    const after = applyOps(step.after, [{ op: "update_text", uid: uid("c"), text: "zz" }], PAGE_TITLE);
    expect(stepProblems({ ...step, after })).toEqual(only("meaning"));
  });

  it("an invalid tree is reported as valid", () => {
    const [step] = runSequence(flat(), [{ kind: "indent", row: 0 }]).steps;
    const after = [node("a", 0), node("b", 0), node("c", 2), node("d", 3)];
    expect(stepProblems({ ...step, after, base: after })).toEqual(only("valid"));
  });

  it("ops on a noop are reported as silent", () => {
    const [step] = runSequence(flat(), [{ kind: "indent", row: 0 }]).steps;
    const ops = [{ op: "update_text" as const, uid: uid("a"), text: "a" }];
    expect(stepProblems({ ...step, ops })).toEqual(only("silent"));
  });

  it("ops that change nothing on a step that changed the tree are reported as silent", () => {
    const [step] = runSequence(flat(), [{ kind: "indent", row: 1 }]).steps;
    const ops = [{ op: "update_text" as const, uid: uid("a"), text: "a" }];
    expect(stepProblems({ ...step, ops })).toEqual(only("silent"));
  });

  it("a missing inverse is reported as undoable", () => {
    const [step] = runSequence(flat(), [{ kind: "indent", row: 1 }]).steps;
    expect(stepProblems({ ...step, inverse: null })).toEqual(only("undoable"));
  });

  it("a missing inverse for collapse alone is not reported", () => {
    const [step] = runSequence(flat(), [{ kind: "collapse", row: 1, value: true }]).steps;
    expect(stepProblems({ ...step, inverse: null })).toEqual([]);
  });

  it("a hidden focus is reported", () => {
    const [step] = runSequence(folded(), [{ kind: "indent", row: 2 }]).steps;
    expect(stepProblems(step)).toEqual([]);
    expect(stepProblems({ ...step, focus: { uid: uid("a1"), cursor: caret(0) } }))
      .toEqual(only("focus"));
  });

  it("a focus outside the tree or past the text is reported", () => {
    const [step] = runSequence(flat(), [{ kind: "indent", row: 1 }]).steps;
    expect(stepProblems({ ...step, focus: { uid: uid("zz"), cursor: caret(0) } }))
      .toEqual(only("focus"));
    expect(stepProblems({ ...step, focus: { uid: uid("b"), cursor: caret(2) } }))
      .toEqual(only("focus"));
    expect(stepProblems({ ...step, focus: { uid: uid("b"), cursor: caret(-1) } }))
      .toEqual(only("focus"));
    expect(stepProblems({ ...step, focus: { uid: uid("b"), cursor: caret(1) } })).toEqual([]);
  });

  it("an undo that misses the rows before its entry is reported", () => {
    const run = runSequence(flat(), [{ kind: "indent", row: 1 }, { kind: "undo" }]);
    const step = run.steps[1];
    expect(stepProblems(step)).toEqual([]);
    const expectedRows = readingRows(run.steps[0].after);
    expect(stepProblems({ ...step, undo: { expectedRows } })).toEqual(only("undo-stack"));
  });

  it("an undo whose ops change nothing while the tree changed is reported as silent", () => {
    const step = runSequence(flat(), [{ kind: "indent", row: 1 }, { kind: "undo" }]).steps[1];
    expect(stepProblems({ ...step, ops: [] })).toEqual(only("silent"));
  });

  it("an undo focus outside the tree is reported", () => {
    const step = runSequence(flat(), [{ kind: "indent", row: 1 }, { kind: "undo" }]).steps[1];
    expect(stepProblems({ ...step, focus: { uid: uid("zz"), cursor: caret(0) } }))
      .toEqual(only("focus"));
  });

  it("an undo that returns focus under a block collapsed since is reported", () => {
    // Split c under p (focus on c is the entry's focusBefore), collapse p,
    // which records nothing, then undo: the app restores focus to c, hidden.
    const start = [node("p", 0, {}, [node("c", 0, { text: "cc" })])];
    const run = runSequence(start, [
      { kind: "split", row: 1, caret: 50 },
      { kind: "collapse", row: 0, value: true },
      { kind: "undo" },
    ]);
    const undo = run.steps[2];
    expect(undo.focus?.uid).toBe("c");
    expect(stepProblems(undo)).toEqual(only("focus"));
  });
});

describe("sequenceProblems", () => {
  it("a clean sequence has no problems", () => {
    const start = flat();
    const run = runSequence(start, [
      { kind: "type", row: 1, text: "zz" },
      { kind: "indent", row: 1 },
      { kind: "indent", row: 2 },
      { kind: "undo" },
      { kind: "redo" },
    ]);
    expect(sequenceProblems(start, run)).toEqual([]);
  });

  it("typing then undoing is clean", () => {
    for (const commands of [
      [{ kind: "type", row: 0, text: "longtext" }, { kind: "undo" }],
      [{ kind: "type", row: 1, text: "longtext" }, { kind: "undo" }],
      [{ kind: "type", row: 0, text: "longtext" }, { kind: "indent", row: 1 }, { kind: "undo" }],
      [{ kind: "type", row: 1, text: "longtext" }, { kind: "indent", row: 1 }, { kind: "undo" }],
    ] satisfies Command[][]) {
      const start = [node("a", 0), node("b", 1)];
      const run = runSequence(start, commands);
      expect(run.steps.flatMap(stepProblems)).toEqual([]);
      expect(sequenceProblems(start, run)).toEqual([]);
    }
  });

  it("a sequence ending in undo redoes all to the newest entry", () => {
    const start = flat();
    const run = runSequence(start, [
      { kind: "indent", row: 1 },
      { kind: "indent", row: 2 },
      { kind: "undo" },
    ]);
    expect(run.history.redo).toHaveLength(1);
    expect(sequenceProblems(start, run)).toEqual([]);
  });

  it("step problems carry the step they came from", () => {
    const start = flat();
    const run = runSequence(start, [{ kind: "indent", row: 0 }, { kind: "indent", row: 1 }]);
    const steps = [run.steps[0], { ...run.steps[1], inverse: null }];
    expect(sequenceProblems(start, { ...run, steps }))
      .toEqual([expect.stringMatching(/^undoable: .*step 1 indent/)]);
  });

  it("undo-all that misses the start is reported", () => {
    const start = flat();
    const run = runSequence(start, [{ kind: "indent", row: 1 }]);
    const [entry] = run.history.undo;
    const doctored: Run = { ...run, history: { ...run.history, undo: [{ ...entry, inverse: [] }] } };
    const problems = sequenceProblems(start, doctored);
    expect(problems).toContainEqual(expect.stringMatching(/^undo-all: /));
    expect(problems.filter((p) => !/^(undo-all|redo-all): /.test(p))).toEqual([]);
  });

  it("redo-all that misses the newest entry is reported", () => {
    const start = flat();
    const run = runSequence(start, [{ kind: "indent", row: 1 }, { kind: "indent", row: 2 }]);
    const [first, second] = run.history.undo;
    const doctored: Run = {
      ...run, history: { ...run.history, undo: [first, { ...second, ops: [] }] },
    };
    expect(sequenceProblems(start, doctored)).toEqual(only("redo-all"));
  });

  it("redo-all that misses a pending redo entry is reported", () => {
    const start = flat();
    const run = runSequence(start, [
      { kind: "indent", row: 1 },
      { kind: "indent", row: 2 },
      { kind: "undo" },
    ]);
    const [pending] = run.history.redo;
    const doctored: Run = { ...run, history: { ...run.history, redo: [{ ...pending, ops: [] }] } };
    expect(sequenceProblems(start, doctored)).toEqual(only("redo-all"));
  });
});
