// pattern: Functional Core
// Runs one drawn example through the cell editor the way a table drives it,
// beside the model (cellModel.ts), and checks every step. A click reads the
// cell's stored value, Tab asks `neighbourCell` for the next editable cell,
// and every write lands in the store, so a reopened cell starts from what
// was written. Stops at the first step with a problem and returns every
// problem found there, each led by the invariant it breaks:
// - state, writes: the editor's state and writes equal the model's;
// - idle: the editor is idle exactly when the model has no cell open;
// - one-write: a write is for the open cell, at most one per opening;
// - not-original: no write equals its cell's original, trimmed;
// - cancel-no-write: no write for a cancelled cell until it is reopened;
// - trimmed-draft: a write's value is the draft, trimmed, when its event
//   came;
// - neighbour: Tab's next cell is the model's.
import {
  type CellRef, type EditorEffect, type EditorEvent, type EditorState,
  neighbourCell, stepEditor,
} from "../../tables/cellEditor";
import { type CellExample, type CellStep, GRID } from "./cellArbitraries";
import {
  type CellModel, cellKey, closeWrites, modelEvent, modelNeighbour, type ModelWrite,
} from "./cellModel";

export interface CellMachine {
  readonly step: typeof stepEditor;
  readonly neighbour: typeof neighbourCell;
}

export const REAL: CellMachine = { step: stepEditor, neighbour: neighbourCell };

export interface CellRunResult {
  readonly problems: readonly string[];
  /** The named paths this example reached, for the suite's tally. */
  readonly reached: ReadonlySet<string>;
}

const show = (v: unknown): string => JSON.stringify(v);

/** States and writes spelled field by field, so key order never counts. */
const showState = (s: EditorState): string => s.kind === "idle" ? "idle"
  : `editing ${cellKey(s.cell)} from ${show(s.original)}, draft ${show(s.draft)}`;
const showModel = (m: CellModel): string => m.open === null ? "idle"
  : showState({ kind: "editing", ...m.open });
const showWrites = (ws: readonly ModelWrite[]): string =>
  `[${ws.map((w) => `${cellKey(w.cell)}=${show(w.value)}`).join(", ")}]`;

interface Run {
  readonly store: Map<string, string>;
  /** Cells cancelled and not opened since. */
  readonly cancelled: Set<string>;
  /** Writes since the open cell was opened. */
  writesThisOpening: number;
  readonly written: Set<string>;
}

export function runCellExample(example: CellExample,
                               machine: CellMachine = REAL): CellRunResult {
  const reached = new Set<string>();
  const run: Run = {
    store: new Map(GRID.map((cell, i) => [cellKey(cell), example.values[i] ?? ""])),
    cancelled: new Set(), writesThisOpening: 0, written: new Set(),
  };
  let state: EditorState = { kind: "idle" };
  let model: CellModel = { open: null };

  for (const [i, step] of example.steps.entries()) {
    const built = toEvent(machine, example.order, step, model, run.store);
    const problems = [...built.problems];
    const out = machine.step(state, built.event);
    const next = modelEvent(model, built.event);
    problems.push(...check(step, model, next.model, out.state, out.effects, next.writes, run));
    if (problems.length > 0) {
      return { problems: problems.map((p) => `${p} (step ${i})`), reached };
    }
    label(reached, step, built.event, model, next.writes, example.order, run);
    for (const effect of out.effects) {
      run.store.set(cellKey(effect.cell), effect.value);
      run.written.add(cellKey(effect.cell));
    }
    state = out.state;
    model = next.model;
  }
  return { problems: [], reached };
}

/** The event a table sends for `step`: a click carries the stored value; a
 * Tab carries `neighbourCell`'s next cell, or, with no cell open, the first
 * editable one, as a stale Tab would. */
function toEvent(machine: CellMachine, order: readonly CellRef[], step: CellStep,
                 model: CellModel, store: ReadonlyMap<string, string>):
    { event: EditorEvent; problems: string[] } {
  const valued = (cell: CellRef) => ({ cell: { ...cell }, value: store.get(cellKey(cell)) ?? "" });
  if (step.kind === "open") return { event: { kind: "open", ...valued(step.cell) }, problems: [] };
  if (step.kind !== "tab") return { event: step, problems: [] };
  if (model.open === null) {
    const first = order[0];
    return { event: { kind: "tab", dir: step.dir, next: first ? valued(first) : null },
             problems: [] };
  }
  const cur = { ...model.open.cell };
  const got = machine.neighbour(order.map((c) => ({ ...c })), cur, step.dir);
  const want = modelNeighbour(order, cur, step.dir);
  const name = (c: CellRef | null): string => c === null ? "null" : cellKey(c);
  const problems = name(got) === name(want) ? []
    : [`neighbour: from ${cellKey(cur)} by ${step.dir} gave ${name(got)}, model ${name(want)}`];
  return { event: { kind: "tab", dir: step.dir, next: got ? valued(got) : null }, problems };
}

function check(step: CellStep, prior: CellModel, model: CellModel, after: EditorState,
               effects: readonly EditorEffect[], wanted: readonly ModelWrite[],
               run: Run): string[] {
  const problems: string[] = [];
  if (showState(after) !== showModel(model)) {
    problems.push(`state: ${showState(after)}, model ${showModel(model)}`);
  }
  if (showWrites(effects) !== showWrites(wanted)) {
    problems.push(`writes: ${showWrites(effects)}, model ${showWrites(wanted)}`);
  }
  if ((after.kind === "idle") !== (model.open === null)) {
    problems.push(`idle: the editor is ${after.kind} while the model has ${
      model.open === null ? "no cell" : cellKey(model.open.cell)} open`);
  }
  const open = prior.open;
  const cancelled = new Set(run.cancelled);
  if (step.kind === "cancel" && open !== null) cancelled.add(cellKey(open.cell));
  let writes = run.writesThisOpening;
  for (const effect of effects) {
    const key = cellKey(effect.cell);
    if (cancelled.has(key)) {
      problems.push(`cancel-no-write: ${show(effect.value)} written to cancelled ${key}`);
    }
    if (open === null || key !== cellKey(open.cell)) {
      problems.push(`one-write: ${key} written while ${open ? cellKey(open.cell) : "no cell"} is open`);
      continue;
    }
    writes += 1;
    if (writes > 1) problems.push(`one-write: ${key} written ${writes} times in one opening`);
    if (effect.value === open.original.trim()) {
      problems.push(`not-original: ${key} written with its original ${show(open.original)}`);
    }
    if (effect.value !== open.draft.trim()) {
      problems.push(`trimmed-draft: ${key} written ${show(effect.value)} from draft ${show(open.draft)}`);
    }
  }
  run.cancelled.clear();
  for (const key of cancelled) run.cancelled.add(key);
  const opening = model.open !== null
    && (open === null || cellKey(open.cell) !== cellKey(model.open.cell));
  if (opening && model.open !== null) run.cancelled.delete(cellKey(model.open.cell));
  run.writesThisOpening = opening ? 0 : writes;
  return problems;
}

function label(reached: Set<string>, step: CellStep, event: EditorEvent, prior: CellModel,
               writes: readonly ModelWrite[], order: readonly CellRef[], run: Run): void {
  const open = prior.open;
  if (open === null) {
    if (step.kind !== "open") reached.add("idle event ignored");
    else if (run.written.has(cellKey(step.cell))) reached.add("reopen a written cell");
    return;
  }
  const changed = closeWrites(open).length > 0;
  const sameCell = step.kind === "open" && cellKey(step.cell) === cellKey(open.cell);
  if (step.kind === "open") {
    reached.add(sameCell ? "open the same cell while editing" : "open while editing another cell");
  }
  if (step.kind === "cancel" && changed) reached.add("cancel a changed draft");
  if (event.kind === "tab" && event.next === null) reached.add("tab to null");
  if (event.kind === "tab" && event.dir === 1 && event.next !== null
      && event.next.cell.row !== open.cell.row) {
    reached.add("tab to the next row");
  }
  if (step.kind === "tab" && !order.some((c) => cellKey(c) === cellKey(open.cell))) {
    reached.add("tab from a cell not editable");
  }
  if (writes.length > 0) {
    reached.add(`write on ${step.kind}`);
    if (writes.some((w) => w.value.includes("\n"))) reached.add("write keeps an inner newline");
  } else if (step.kind !== "input" && step.kind !== "cancel" && !sameCell) {
    reached.add("skip unchanged");
  }
}
