// pattern: Functional Core
// Runs one drawn example through the view-state machine the way a mounted
// table block drives it, beside the model (model.ts), and checks every step.
// Stops at the first step with a problem and returns every problem found
// there, each led by the invariant it breaks:
// - saved, live: the machine's views equal the model's;
// - frozen: the held rows are the first edit's since the last release;
// - dirty: isDirty holds exactly when Save would write different text;
// - loaded-keeps-dirty: a refetch never changes a changed live view;
// - clean: Reset and Save leave nothing to save.
import {
  initialView, isDirty, stepView, type ViewEvent, type ViewState,
} from "../../tables/viewState";
import type { ViewExample, ViewStep } from "./arbitraries";
import { heldRows, modelDirty, modelStep, RELEASES, savedText, type ViewModel } from "./model";

export interface ViewMachine {
  readonly step: (s: ViewState, e: ViewEvent) => ViewState;
  readonly isDirty: (s: ViewState) => boolean;
}

export const REAL: ViewMachine = { step: stepView, isDirty };

export interface ViewRunResult {
  readonly problems: readonly string[];
  /** The named paths this example reached, for the suite's tally. */
  readonly reached: ReadonlySet<string>;
}

const show = (v: unknown): string => JSON.stringify(v);

export function runViewExample(example: ViewExample, machine: ViewMachine = REAL): ViewRunResult {
  const reached = new Set<string>();
  let state = initialView(example.saved);
  let model: ViewModel = { saved: example.saved, live: example.saved };

  for (const [i, step] of example.steps.entries()) {
    const before = state;
    const prior = model;
    const priorDirty = modelDirty(prior);
    state = apply(machine, state, step, model);
    model = modelStep(model, step);
    const problems = check(machine, step, before, state, prior, model,
                           example.steps.slice(0, i + 1));
    if (problems.length > 0) {
      return { problems: problems.map((p) => `${p} (step ${i})`), reached };
    }
    label(reached, step, before, prior, priorDirty, model);
  }
  return { problems: [], reached };
}

function apply(machine: ViewMachine, s: ViewState, step: ViewStep,
               model: ViewModel): ViewState {
  switch (step.kind) {
    case "remount":
      return initialView(model.saved);
    case "refetch":
      return machine.step(s, { kind: "loaded", saved: model.saved });
    default:
      return machine.step(s, step);
  }
}

function check(machine: ViewMachine, step: ViewStep, before: ViewState, after: ViewState,
               prior: ViewModel, model: ViewModel, steps: readonly ViewStep[]): string[] {
  const problems: string[] = [];
  if (show(after.saved) !== show(model.saved)) {
    problems.push(`saved: ${show(after.saved)}, model ${show(model.saved)}`);
  }
  if (show(after.live) !== show(model.live)) {
    problems.push(`live: ${show(after.live)}, model ${show(model.live)}`);
  }
  const held = heldRows(steps);
  if (show(after.frozen) !== show(held)) {
    problems.push(`frozen: ${show(after.frozen)}, the first edit since a release held ${show(held)}`);
  }
  const differs = savedText(after.live) !== savedText(after.saved);
  if (machine.isDirty(after) !== differs) {
    problems.push(`dirty: isDirty ${machine.isDirty(after)}, but Save would write `
      + `${show(savedText(after.live))} over ${show(savedText(after.saved))}`);
  }
  const loads = step.kind === "loaded" || step.kind === "refetch";
  if (loads && modelDirty(prior) && show(after.live) !== show(before.live)) {
    problems.push(`loaded-keeps-dirty: ${show(before.live)} became ${show(after.live)}`);
  }
  if ((step.kind === "reset" || step.kind === "saved") && machine.isDirty(after)) {
    problems.push(`clean: still dirty after ${step.kind}`);
  }
  return problems;
}

function label(reached: Set<string>, step: ViewStep, before: ViewState, prior: ViewModel,
               priorDirty: boolean, model: ViewModel): void {
  const dirty = modelDirty(model);
  if (dirty) reached.add("dirty");
  if (priorDirty && !dirty && (step.kind === "filter" || step.kind === "sortClick")) {
    reached.add("dirty, then clean by changing back");
  }
  if (!dirty && model.live.filter !== model.saved.filter) {
    reached.add("filter differs by padding only");
  }
  if (step.kind === "loaded" && savedText(step.saved) !== savedText(prior.saved)) {
    reached.add(priorDirty ? "loaded a new saved view on dirty" : "loaded a new saved view on clean");
  }
  if (step.kind === "refetch" && priorDirty) reached.add("refetch on dirty");
  if (before.frozen !== null) {
    if (step.kind === "edited") reached.add("second edit keeps the snapshot");
    else if (RELEASES.has(step.kind)) reached.add(`edited, then ${step.kind} releases`);
    else reached.add(`held through ${step.kind}`);
  }
  if (step.kind === "sortClick" && prior.live.sort?.col === step.col
      && model.live.sort === null) {
    reached.add("sort cycled off");
  }
  if (priorDirty && (step.kind === "reset" || step.kind === "saved")) {
    reached.add(`${step.kind} from dirty`);
  }
}
