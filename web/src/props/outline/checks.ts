// pattern: Functional Core
// The suite's properties, stated over what the runner recorded. Each problem
// names its property first (valid, meaning, silent, undoable, focus,
// undo-stack, undo-all, redo-all) so a failing run says which one broke.
import type { BlockNode } from "../../api/payloads";
import { takeRedo, takeUndo, type HistoryState } from "../../outline/history";
import { applyOpsWithChange, blocksEqual } from "../../outline/tree";
import { PAGE_TITLE } from "./arbitraries";
import { expectedRows } from "./model";
import { readingRows, rowsDiff, structural, treeProblems, type Row } from "./reading";
import { replayEntry, type Run, type Step } from "./run";

/** null when the structural lines match, else the first that differs. */
function structuralDiff(expected: readonly Row[], actual: readonly Row[]): string | null {
  const [want, got] = [structural(expected), structural(actual)];
  const n = Math.max(want.length, got.length);
  for (let i = 0; i < n; i++) {
    if (want[i] !== got[i]) {
      return `row ${i} differs: expected ${want[i] ?? "(none)"}, actual ${got[i] ?? "(none)"}`;
    }
  }
  return null;
}

const valid = (blocks: readonly BlockNode[]): string[] =>
  treeProblems(blocks).map((p) => `valid: ${p}`);

/** Properties 1–5 for a command step; 1 and the undo-stack model for undo/redo. */
export function stepProblems(step: Step): string[] {
  const problems = valid(step.after);
  const afterRows = readingRows(step.after);

  if (step.command.kind === "undo" || step.command.kind === "redo") {
    if (!step.undo) throw new Error("checks: undo/redo step without expected rows");
    const diff = structuralDiff(step.undo.expectedRows, afterRows);
    if (diff) problems.push(`undo-stack: ${step.command.kind} ${diff}`);
    return problems;
  }

  // A command with no visible row to act on is a noop.
  const baseRows = readingRows(step.base);
  const expected = step.resolved ? expectedRows(baseRows, step.resolved) : { kind: "noop" as const };
  const diff = rowsDiff(expected.kind === "noop" ? baseRows : expected.rows, afterRows);
  if (diff) problems.push(`meaning: ${diff}`);

  if ((expected.kind === "noop") !== (step.ops.length === 0)) {
    problems.push(expected.kind === "noop"
      ? `silent: the model calls this a no-op but it emitted ${JSON.stringify(step.ops)}`
      : "silent: the model expects a change but it emitted no ops");
  }
  const changed = applyOpsWithChange(step.base, step.ops, PAGE_TITLE).changed;
  if (changed === blocksEqual(step.base, step.after)) {
    problems.push(changed
      ? "silent: its ops change the tree they ran on, but the tree after equals it"
      : "silent: its ops change nothing on the tree they ran on, but the tree after differs");
  }

  if (step.inverse === null && step.ops.some((op) => op.op !== "set_collapsed")) {
    problems.push(`undoable: no inverse for ${JSON.stringify(step.ops)}`);
  }

  if (step.focus) {
    const { uid, cursor } = step.focus;
    const row = afterRows.find((r) => r.uid === uid);
    if (!row) problems.push(`focus: ${uid} is not in the tree`);
    else if (row.hidden) problems.push(`focus: ${uid} is hidden under a collapsed ancestor`);
    else if (cursor < 0 || cursor > row.text.length) {
      problems.push(`focus: caret ${cursor} on ${uid} is outside [0, ${row.text.length}]`);
    }
  }
  return problems;
}

/** Replays every entry on one side of the stack, newest first. */
function replayAll(tree: BlockNode[], history: HistoryState, direction: "undo" | "redo",
                   problems: string[], property: string):
    { tree: BlockNode[]; history: HistoryState } {
  for (let k = 0; ; k++) {
    const { state, entry } = direction === "undo" ? takeUndo(history) : takeRedo(history);
    if (!entry) return { tree, history };
    history = state;
    tree = replayEntry(tree, entry, direction);
    for (const p of treeProblems(tree)) problems.push(`${property}: ${direction} ${k}: ${p}`);
  }
}

/** Every step's problems, then properties 6–7 over the whole history. */
export function sequenceProblems(start: BlockNode[], run: Run): string[] {
  const problems = run.steps.flatMap((step, i) =>
    stepProblems(step).map((p) => `${p} [step ${i} ${step.command.kind}]`));

  // The redo-all target is the tree after the newest entry. A sequence that
  // ended in undo still holds entries on its redo stack, so the target is
  // run.end with that pending redo stack replayed; when it is empty, the
  // target is run.end itself.
  const target = replayAll(run.end, run.history, "redo", [], "redo-all").tree;

  const undone = replayAll(run.end, run.history, "undo", problems, "undo-all");
  const missed = structuralDiff(readingRows(start), readingRows(undone.tree));
  if (missed) problems.push(`undo-all: the start ${missed}`);

  const redone = replayAll(undone.tree, undone.history, "redo", problems, "redo-all");
  const short = structuralDiff(readingRows(target), readingRows(redone.tree));
  if (short) problems.push(`redo-all: the newest entry ${short}`);
  return problems;
}
