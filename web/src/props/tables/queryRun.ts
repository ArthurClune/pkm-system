// pattern: Functional Core
// Runs one drawn example through a query block's reducer (queryBlock.ts)
// the way QueryResults drives it, beside the model (queryModel.ts) and the
// requests out (queryFetch.ts), and checks what the block shows and
// fetches after every step. A records answer lands through the reducer,
// which holds records under the rows held then and steps the view with
// the saved view the macro's options and the new defaults give; Save
// writes the options and they come back as the macro's; an edit steps the
// view with what is on screen (editedEvent), and is skipped where no cell
// can be written; after each step the groups effect starts any fetch due.
// Stops at the first step with a problem and returns every problem found
// there, each led by the invariant it breaks:
// - frozen: rows are held exactly when the model says (stepView's rule,
//   whose mutants are in teeth.prop.ts);
// - held-iff-frozen: the snapshot is set exactly while the rows are held;
// - hold-view, hold-columns: a field that follows the defaults shows what
//   the first edit saw;
// - hold-keys: a held column's key is the current stats', else the first
//   edit's;
// - hold-rows: the held rows are the first edit's, in order, and one the
//   records lack is stale;
// - chosen: a field the macro sets shows the live view's;
// - released: with no rows held, the live view, its columns, and the
//   current records through the live filter and sort. The rows are judged
//   by shownRows itself: this suite checks the hold, and the filter and
//   sort have their own unit tests and the table view property;
// - the fetch rules, listed in queryFetch.ts.
import type { QueryRecordsPayload } from "../../api/payloads";
import type { MacroOptions } from "../../grammar/macroOptions";
import {
  initialQueryBlock, QUERY_BLOCK, type QueryBlock, type QueryBlockEvent,
  type QueryBlockState,
} from "../../tables/queryBlock";
import { queryColumns, queryDefaults, shownRows } from "../../tables/queryView";
import { editedEvent, type QueryShown } from "../../tables/queryViewState";
import { optionsFromView, viewFromOptions } from "../../tables/viewState";
import type { QueryExample, QueryStep } from "./queryArbitraries";
import {
  answerGroups, checkStall, loadOf, mountNet, startDueFetches, type Net,
} from "./queryFetch";
import {
  edited, expected, loadedStep, readerStep, type QueryModel,
} from "./queryModel";

export interface QueryRunResult {
  readonly problems: readonly string[];
  /** The named paths this example reached, for the suite's tally. */
  readonly reached: ReadonlySet<string>;
}

interface Run {
  readonly block: QueryBlock;
  state: QueryBlockState;
  model: QueryModel;
  readonly net: Net;
  /** Problems found inside a step, by the fetch rules. */
  readonly problems: string[];
  readonly reached: Set<string>;
}

const show = (v: unknown): string => JSON.stringify(v);

function shownOf(r: Run): QueryShown {
  const shown = r.block.shown(r.state);
  if (shown === null) throw new Error("the block shows nothing once loaded");
  return shown;
}

function loadedOf(s: QueryBlockState) {
  if (s.loaded === null || s.qv === null) {
    throw new Error("the block holds no view once loaded");
  }
  return { loaded: s.loaded, qv: s.qv };
}

export function runQueryExample(example: QueryExample,
                                block: QueryBlock = QUERY_BLOCK): QueryRunResult {
  const defaults = queryDefaults(example.first);
  const saved = viewFromOptions(example.options, defaults);
  const r: Run = {
    block, state: initialQueryBlock(example.options),
    model: { view: { saved, live: saved }, options: example.options,
             keys: example.first.keys, records: example.first.records,
             first: null },
    net: mountNet(), problems: [], reached: new Set(),
  };
  effects(r, example.options.view === "blocks");
  landRecords(r, example.first, false);
  effects(r);
  const mounted = [...r.problems, ...checkStall(r.state, r.net, r.reached)];
  if (mounted.length > 0) {
    return { problems: mounted.map((p) => `${p} (mount)`), reached: r.reached };
  }
  for (const [i, step] of example.steps.entries()) {
    const prior = r.model;
    apply(r, step);
    effects(r);
    const problems = [...r.problems, ...check(r),
                      ...checkStall(r.state, r.net, r.reached)];
    if (problems.length > 0) {
      return { problems: problems.map((p) => `${p} (step ${i})`),
               reached: r.reached };
    }
    label(r.reached, step, prior, r.model);
  }
  return { problems: [], reached: r.reached };
}

const dispatch = (r: Run, e: QueryBlockEvent): void => {
  r.state = r.block.step(r.state, e);
};

/** The groups effect; `wants` is the blocks view shown, from the model
 * once the first records landed. */
function effects(r: Run, wants = expected(r.model).view === "blocks"): void {
  r.state = startDueFetches(r.block, r.state, r.net, wants,
                            r.model.options.view === "blocks", r.problems,
                            r.reached);
}

/** The macro's options, from an edit elsewhere or a Save. */
function setOptions(r: Run, options: MacroOptions): void {
  const { loaded } = loadedOf(r.state);
  dispatch(r, { kind: "options", options });
  r.model = loadedStep(r.model, viewFromOptions(options, loaded.defaults),
                       { options });
}

/** The records answer for the current load: `step` false for the first,
 * which the model starts from. */
function landRecords(r: Run, payload: QueryRecordsPayload, step = true): void {
  const { gen } = r.net;
  r.net.recordsOut = null;
  r.net.settled.add(gen);
  const groups = payload.groups === null ? null : [...payload.groups];
  if (groups !== null) {
    r.net.answers.set(groups, gen);
    r.net.carried.add(gen);
    if (r.net.groupsOut !== null) {
      r.reached.add("records carried the groups while a fetch was out");
    }
  }
  dispatch(r, { kind: "recordsLanded", load: loadOf(gen),
                payload: { ...payload, groups } });
  if (!step) return;
  const saved = viewFromOptions(r.model.options, queryDefaults(payload));
  r.model = loadedStep(r.model, saved,
                       { keys: payload.keys, records: payload.records });
}

function resync(r: Run): void {
  r.net.gen += 1;
  r.net.recordsOut = r.net.gen;
}

function apply(r: Run, step: QueryStep): void {
  switch (step.kind) {
    case "edit": {
      const shown = shownOf(r);
      if (shown.view !== "table" || shown.rows.length === 0) return;
      const e = editedEvent(shown, loadedOf(r.state).loaded.keys);
      const rows = e.kind === "edited" ? e.visibleIds : [];
      dispatch(r, { kind: "view", event: e });
      r.model = edited(r.model, rows);
      return;
    }
    case "load":
      resync(r);
      effects(r);
      landRecords(r, step.payload);
      return;
    case "resync":
      resync(r);
      return;
    case "answer":
      if (r.net.recordsOut === null) return;
      if (step.payload !== null) {
        landRecords(r, step.payload);
        return;
      }
      r.net.recordsOut = null;
      r.net.settled.add(r.net.gen);
      dispatch(r, { kind: "recordsFailed", load: loadOf(r.net.gen),
                    error: "records failed" });
      return;
    case "groups":
      r.state = answerGroups(r.block, r.state, r.net, step.ok, r.problems,
                             r.reached);
      return;
    case "macro":
      setOptions(r, step.options);
      return;
    case "saved": {
      dispatch(r, { kind: "view", event: step });
      r.model = readerStep(r.model, step);
      const { loaded, qv } = loadedOf(r.state);
      setOptions(r, optionsFromView(qv.view.live, loaded.defaults));
      return;
    }
    default:
      dispatch(r, { kind: "view", event: step });
      r.model = readerStep(r.model, step);
  }
}

function check(r: Run): string[] {
  const problems: string[] = [];
  const { model } = r;
  const { qv } = loadedOf(r.state);
  const shown = shownOf(r);
  const want = expected(model);
  const frozen = qv.view.frozen !== null;
  if (frozen !== (want.rows !== null)) {
    problems.push(`frozen: ${show(qv.view.frozen)}, model ${show(want.rows)}`);
  }
  if ((qv.held !== null) !== frozen) {
    problems.push(`held-iff-frozen: held ${show(qv.held)}, frozen ${frozen}`);
  }
  const field = (follows: boolean): string =>
    want.rows === null ? "released" : follows ? "hold" : "chosen";
  if (shown.view !== want.view) {
    const name = field(want.viewFollows);
    problems.push(`${name === "hold" ? "hold-view" : name}: view ${shown.view}, `
      + `model ${want.view}`);
  }
  const labels = shown.columns.map((c) => c.label);
  const wantLabels = want.columns.map((c) => c.label);
  if (show(labels) !== show(wantLabels)) {
    const name = field(want.columnsFollow);
    problems.push(`${name === "hold" ? "hold-columns" : name}: columns `
      + `${show(labels)}, model ${show(wantLabels)}`);
  } else if (show(shown.columns.map((c) => c.key))
             !== show(want.columns.map((c) => c.key))) {
    problems.push(`${want.rows === null ? "released" : "hold-keys"}: keys `
      + `${show(shown.columns)}, model ${show(want.columns)}`);
  }
  const rows = shown.rows.map((r) => r.record.key);
  if (want.rows !== null) {
    const present = new Set(model.records.map((r) => r.key));
    const unmarked = shown.rows.filter((r) =>
      !present.has(r.record.key) && !r.stale);
    if (show(rows) !== show(want.rows) || unmarked.length > 0) {
      problems.push(`hold-rows: ${show(shown.rows.map((r) =>
        [r.record.key, r.stale]))}, the first edit held ${show(want.rows)}`);
    }
  } else {
    const live = model.view.live;
    const columns = queryColumns(live.columns, model.keys);
    const oracle = shownRows(model.records, columns, live, null).rows
      .map((r) => [r.record.key, r.stale]);
    const got = shown.rows.map((r) => [r.record.key, r.stale]);
    if (show(got) !== show(oracle)) {
      problems.push(`released: rows ${show(got)}, the live view gives ${show(oracle)}`);
    }
  }
  return problems;
}

function label(reached: Set<string>, step: QueryStep, prior: QueryModel,
               model: QueryModel): void {
  const was = expected(prior);
  const now = expected(model);
  if (was.rows !== null) {
    if (step.kind === "edit") reached.add("a second edit keeps the snapshot");
    if (now.rows === null) reached.add(`${step.kind} releases a hold`);
    if (step.kind === "saved" && now.rows !== null) reached.add("saved while held");
  }
  if (now.rows === null) return;
  if (step.kind === "load") {
    const named = new Set(step.payload.keys.map((k) => k.label));
    const first = model.first;
    if (now.columnsFollow && first?.labels.some((l) => !named.has(l))) {
      reached.add("held a column the load's records no longer hold");
    }
    if (now.viewFollows && step.payload.groups !== null && now.view === "table") {
      reached.add("held the table through a load whose default is blocks");
    }
    const present = new Set(step.payload.records.map((r) => r.key));
    if (now.rows.some((id) => !present.has(id))) {
      reached.add("held a row the load dropped");
    }
  }
  if (!now.columnsFollow) reached.add("held with columns the macro sets");
  if (!now.viewFollows && model.first?.view !== now.view) {
    reached.add("held with a view the macro sets, not the first edit's");
  }
  if (now.columns.some((c) => !model.keys.some((k) => k.label === c.label)
      && prior.first?.stats.some((k) => k.label === c.label))) {
    reached.add("keyed a held column by the first edit's stats");
  }
}
