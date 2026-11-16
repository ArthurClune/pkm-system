// pattern: Functional Core
// Runs one drawn example through a query block's view the way QueryResults
// drives it, beside the model (queryModel.ts), and checks what the block
// shows after every step. A load holds records (holdRecords) under the
// rows held when it lands and steps the view with the saved view the
// macro's options and the new defaults give; Save writes the options and
// loads them back; an edit steps the view with what is on screen
// (editedEvent), and is skipped where no cell can be written. Stops at the
// first step with a problem and returns every problem found there, each
// led by the invariant it breaks:
// - frozen: rows are held exactly when the model says;
// - held-iff-frozen: the snapshot is set exactly while the rows are held;
// - hold-view, hold-columns: a field that follows the defaults shows what
//   the first edit saw;
// - hold-keys: a held column's key is the current stats', else the first
//   edit's;
// - hold-rows: the held rows are the first edit's, in order, and one the
//   records lack is stale;
// - chosen: a field the macro or reader chose shows the live view's;
// - released: with no rows held, the live view, its columns, and the
//   current records through the live filter and sort.
import type { QueryRecordModel } from "../../api/payloads";
import type { MacroOptions } from "../../grammar/macroOptions";
import {
  holdRecords, queryColumns, queryDefaults, shownRows,
} from "../../tables/queryView";
import {
  editedEvent, initialQueryView, showQuery, stepQueryView,
  type QueryShown, type QueryViewState,
} from "../../tables/queryViewState";
import {
  optionsFromView, viewFromOptions, type ViewDefaults,
} from "../../tables/viewState";
import type { QueryExample, QueryStep } from "./queryArbitraries";
import {
  edited, expected, loadedStep, readerStep, type QueryModel,
} from "./queryModel";

export interface QueryMachine {
  readonly step: typeof stepQueryView;
  readonly show: typeof showQuery;
  readonly hold: typeof holdRecords;
}

export const REAL_QUERY: QueryMachine = {
  step: stepQueryView, show: showQuery, hold: holdRecords,
};

export interface QueryRunResult {
  readonly problems: readonly string[];
  /** The named paths this example reached, for the suite's tally. */
  readonly reached: ReadonlySet<string>;
}

interface Block {
  qv: QueryViewState;
  options: MacroOptions;
  keys: QueryExample["first"]["keys"];
  defaults: ViewDefaults;
  records: readonly QueryRecordModel[];
  held: ReadonlyMap<string, QueryRecordModel>;
}

const show = (v: unknown): string => JSON.stringify(v);

const shownOf = (m: QueryMachine, b: Block): QueryShown =>
  m.show(b.qv, b.options, b.keys, b.records, b.held);

export function runQueryExample(example: QueryExample,
                                machine: QueryMachine = REAL_QUERY): QueryRunResult {
  const reached = new Set<string>();
  const defaults = queryDefaults(example.first);
  const saved = viewFromOptions(example.options, defaults);
  let block: Block = {
    qv: initialQueryView(saved), options: example.options,
    keys: example.first.keys, defaults, records: example.first.records,
    held: new Map(),
  };
  let model: QueryModel = {
    view: { saved, live: saved }, options: example.options,
    keys: example.first.keys, records: example.first.records, first: null,
  };
  for (const [i, step] of example.steps.entries()) {
    const before = block;
    const prior = model;
    [block, model] = apply(machine, block, model, step);
    const problems = check(machine, block, model);
    if (problems.length > 0) {
      return { problems: problems.map((p) => `${p} (step ${i})`), reached };
    }
    label(reached, step, before, block, prior, model);
  }
  return { problems: [], reached };
}

function load(m: QueryMachine, b: Block, model: QueryModel,
              options: MacroOptions,
              payload?: QueryExample["first"]): [Block, QueryModel] {
  const data = payload ?? { keys: b.keys, records: b.records };
  const defaults = payload === undefined ? b.defaults : queryDefaults(payload);
  const saved = viewFromOptions(options, defaults);
  const held = payload === undefined ? b.held
    : m.hold(b.records, b.held, payload.records, b.qv.view.frozen);
  return [
    { qv: m.step(b.qv, { kind: "loaded", saved }), options, keys: data.keys,
      defaults, records: data.records, held },
    loadedStep(model, saved, { options, keys: data.keys, records: data.records }),
  ];
}

function apply(m: QueryMachine, b: Block, model: QueryModel,
               step: QueryStep): [Block, QueryModel] {
  switch (step.kind) {
    case "edit": {
      const shown = shownOf(m, b);
      if (shown.view !== "table" || shown.rows.length === 0) return [b, model];
      const e = editedEvent(shown, b.keys);
      const rows = e.kind === "edited" ? e.visibleIds : [];
      return [{ ...b, qv: m.step(b.qv, e) }, edited(model, rows)];
    }
    case "load":
      return load(m, b, model, b.options, step.payload);
    case "macro":
      return load(m, b, model, step.options);
    case "saved": {
      const next: [Block, QueryModel] = [
        { ...b, qv: m.step(b.qv, step) }, readerStep(model, step)];
      return load(m, next[0], next[1],
                  optionsFromView(next[0].qv.view.live, b.defaults));
    }
    default:
      return [{ ...b, qv: m.step(b.qv, step) }, readerStep(model, step)];
  }
}

function check(m: QueryMachine, b: Block, model: QueryModel): string[] {
  const problems: string[] = [];
  const shown = shownOf(m, b);
  const want = expected(model);
  const frozen = b.qv.view.frozen !== null;
  if (frozen !== (want.rows !== null)) {
    problems.push(`frozen: ${show(b.qv.view.frozen)}, model ${show(want.rows)}`);
  }
  if ((b.qv.held !== null) !== frozen) {
    problems.push(`held-iff-frozen: held ${show(b.qv.held)}, frozen ${frozen}`);
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

function label(reached: Set<string>, step: QueryStep, before: Block,
               after: Block, prior: QueryModel, model: QueryModel): void {
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
  if (now.columns.some((c) => !after.keys.some((k) => k.label === c.label)
      && before.qv.held?.keys.some((k) => k.label === c.label))) {
    reached.add("keyed a held column by the first edit's stats");
  }
}
