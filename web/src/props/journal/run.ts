// pattern: Functional Core
// Runs one drawn example through the journal paging reducer the way
// Journal.tsx drives it, beside the model (model.ts), and checks every step.
// A fake server answers each request the reducer issued from a fixed list of
// non-empty days, newest first. Stops at the first step with a problem and
// returns every problem found there, each led by the property it breaks.
import {
  initialJournalPaging, journalPager, journalPaging,
  type JournalPaging, type JournalPagingEvent,
} from "../../views/journalPaging";
import type { Example, Step } from "./arbitraries";
import {
  abandoned, failed, isCurrent, MODEL_START, olderLoad, pager, resyncLoad,
  SERVER_MAX_DAYS, started, succeeded, type Model, type ModelLoad,
} from "./model";

export interface Day { readonly date: string }
type State = JournalPaging<Day>;
export type Reducer = (state: State, event: JournalPagingEvent<Day>) => State;

export const REAL: Reducer = journalPaging;

interface Pending {
  readonly id: number;
  readonly want: number;
  readonly before: string | undefined;
}

export interface RunResult {
  readonly problems: readonly string[];
  /** The named paths this example reached, for the suite's tally. */
  readonly reached: ReadonlySet<string>;
  /** The step the problems were found at, or the step count when none. */
  readonly at: number;
}

/** The server's day `i`, counted back from today: ISO dates sort newest
 * first exactly when `i` ascends. */
export function serverDate(i: number): string {
  return new Date(Date.UTC(2026, 10, 8 - i)).toISOString().slice(0, 10);
}

function answer(serverDays: number, req: Pending): Day[] {
  const all = Array.from({ length: serverDays }, (_, i) => ({ date: serverDate(i) }));
  const from = req.before === undefined
    ? 0 : all.findIndex((d) => d.date === req.before) + 1;
  if (from === 0 && req.before !== undefined) return [];
  return all.slice(from, from + Math.min(req.want, SERVER_MAX_DAYS));
}

const same = (a: State, b: State): boolean => JSON.stringify(a) === JSON.stringify(b);

export function runExample(example: Example, reduce: Reducer = REAL): RunResult {
  const { serverDays } = example;
  const reached = new Set<string>();
  let state: State = initialJournalPaging<Day>();
  let model: Model = MODEL_START;
  let pending: Pending[] = [];
  /** A head load failed with days on screen and nothing has landed since. */
  let reloadFailed = false;
  /** The older load started after that failure, while it is in flight. */
  let olderAfterFailure: number | null = null;

  /** Dispatch a starting event and check the reducer started a load exactly
   * when the model says one starts. */
  const startEvent = (event: JournalPagingEvent<Day>,
                      expected: Omit<ModelLoad, "id"> | null,
                      problems: string[]): void => {
    const before = state;
    state = reduce(state, event);
    const load = state.loading !== null && state.loading !== before.loading
      ? state.loading : null;
    if ((load === null) !== (expected === null)) {
      problems.push(`request: ${event.type} ${expected === null ? "started a load the model ignores"
        : "started no load"}`);
      return;
    }
    if (load === null || expected === null) {
      if (event.type === "older" && model.inFlight !== null) reached.add("older ignored in flight");
      return;
    }
    if (model.inFlight !== null) reached.add(`${event.type} supersedes a load in flight`);
    model = started(model, { ...expected, id: load.id });
    pending.push({ id: load.id, want: load.want, before: load.before });
    if (reloadFailed && expected.kind === "older") olderAfterFailure = load.id;
  };

  const mount = (problems: string[]): void =>
    startEvent({ type: "older" }, olderLoad(model), problems);

  const respond = (step: Extract<Step, { t: "respond" }>, problems: string[]): void => {
    if (pending.length === 0) {
      reached.add("respond with nothing pending");
      return;
    }
    const [req] = pending.splice(step.pick % pending.length, 1);
    const current = isCurrent(model, req.id);
    const before = state;
    const prior = model;
    state = reduce(state, step.ok
      ? { type: "loaded", id: req.id, days: answer(serverDays, req) }
      : { type: "failed", id: req.id, message: "500" });
    if (!current) {
      reached.add("stale answer");
      if (!same(before, state)) {
        problems.push(`stale: a superseded load's ${step.ok ? "result" : "failure"} changed the state`);
      }
      return;
    }
    if (!step.ok) {
      model = failed(model);
      if (prior.inFlight?.kind === "head" && prior.shown > 0) {
        reloadFailed = true;
        reached.add("resync reload fails");
      }
      if (prior.error) reached.add("fail after fail");
      return;
    }
    model = succeeded(model, serverDays);
    if (prior.error) reached.add("success clears an error");
    if (olderAfterFailure === req.id) reached.add("failed reload, then an older load lands");
    if (prior.inFlight?.kind === "head" && prior.shown > SERVER_MAX_DAYS) {
      reached.add("resync over the server cap");
    }
    if (model.done) reached.add("past exhausted");
    reloadFailed = false;
    olderAfterFailure = null;
  };

  const check = (before: State, step: Step | null, problems: string[]): void => {
    const dates = state.days.map((d) => d.date);
    const prefix = Array.from({ length: dates.length }, (_, i) => serverDate(i));
    if (dates.join() !== prefix.join()) {
      problems.push(`contiguous: shown ${dates.join(" ")}, not the server's newest ${dates.length}`);
    }
    if (step?.t !== "remount" &&
        state.days.length < Math.min(before.days.length, SERVER_MAX_DAYS)) {
      problems.push(`never-shrinks: ${before.days.length} days became ${state.days.length}`);
    }
    if (state.days.length !== model.shown) {
      problems.push(`days: ${state.days.length} shown, the model shows ${model.shown}`);
    }
    if ((state.error !== null) !== model.error) {
      problems.push(`error: shown=${state.error !== null}, model=${model.error}`);
    }
    if (state.done !== model.done) problems.push(`done: ${state.done}, model ${model.done}`);
    if ((state.loading !== null) !== (model.inFlight !== null)) {
      problems.push(`in-flight: loading=${state.loading !== null}, model=${model.inFlight !== null}`);
    }
    if (journalPager(state) !== pager(model)) {
      problems.push(`pager: ${journalPager(state)}, model ${pager(model)}`);
    }
  };

  {
    const problems: string[] = [];
    const before = state;
    mount(problems);
    check(before, null, problems);
    if (problems.length > 0) return { problems: problems.map((p) => `${p} (mount)`), reached, at: -1 };
  }

  for (const [i, step] of example.steps.entries()) {
    const problems: string[] = [];
    const before = state;
    switch (step.t) {
      case "older":
        startEvent({ type: "older" }, olderLoad(model), problems);
        break;
      case "resync":
        startEvent({ type: "resync" }, resyncLoad(model), problems);
        break;
      case "respond":
        respond(step, problems);
        break;
      case "replay":
        if (model.inFlight !== null) reached.add("strict replay with a load in flight");
        state = reduce(state, { type: "abandon" });
        model = abandoned(model);
        reloadFailed = false;
        olderAfterFailure = null;
        mount(problems);
        break;
      case "remount":
        if (pending.length > 0) reached.add("remount with requests outstanding");
        state = initialJournalPaging<Day>();
        model = MODEL_START;
        pending = [];
        reloadFailed = false;
        olderAfterFailure = null;
        mount(problems);
        break;
    }
    check(before, step, problems);
    if (problems.length > 0) {
      return { problems: problems.map((p) => `${p} (step ${i})`), reached, at: i };
    }
  }
  return { problems: [], reached, at: example.steps.length };
}
