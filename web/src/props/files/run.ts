// pattern: Functional Core
// Runs one drawn example through the Files paging reducer the way Files.tsx
// drives it, beside the model (model.ts), and checks every step. A fake
// server answers each request from a fixed list of files per filter. Stops
// at the first step with a problem and returns every problem found there,
// each led by the invariant it breaks.
import type { AssetSearchItem } from "../../api/payloads";
import {
  filesPaging, initialFilesPaging, LOAD_MORE_FAILED, listIsCurrent,
  SELECT_ALL_FAILED, type FilesPaging, type FilesPagingEvent,
} from "../../views/filesPaging";
import { shaOf } from "../../test-mint";
import type { Example, Step } from "./arbitraries";
import {
  bumped, canMore, canSelectAll, isCurrentList, MODEL_START, moreAnswered,
  PAGE, reloadAnswered, selectAllAnswered, toggled, type Model,
} from "./model";

export type Reducer = (state: FilesPaging, event: FilesPagingEvent) => FilesPaging;
export const REAL: Reducer = filesPaging;

export interface RunResult {
  readonly problems: readonly string[];
  /** The named paths this example reached, for the suite's tally. */
  readonly reached: ReadonlySet<string>;
  /** The step the problems were found at, or the step count when none. */
  readonly at: number;
}

interface Pending {
  readonly kind: "reload" | "more" | "selectAll";
  readonly gen: number;
  readonly filter: number;
  /** Files on screen when it started: where Load more asks from. */
  readonly offset: number;
}

/** File `position` of filter `filter`'s list. */
export function file(filter: number, position: number): AssetSearchItem {
  const sha = shaOf((filter * 100 + position).toString(16).padStart(64, "0"));
  return { sha256: sha, filename: `f${filter}-${position}.png`,
           mime: "image/png", size: 1, created_at: 0, url: `/assets/${sha}`,
           description: null, status: "described", describe_error: null,
           refs: [] };
}

function list(filter: number, size: number, from: number, count: number): AssetSearchItem[] {
  const to = Math.min(size, from + count);
  return Array.from({ length: Math.max(0, to - from) }, (_, i) => file(filter, from + i));
}

/** Everything but the selection's order, which a Set does not carry. */
function snapshot(state: FilesPaging): string {
  return JSON.stringify({ ...state, selected: [...state.selected].sort() });
}

export function runExample(example: Example, reduce: Reducer = REAL): RunResult {
  const { sizes } = example;
  const reached = new Set<string>();
  let state: FilesPaging = initialFilesPaging();
  let model: Model = MODEL_START;
  let pending: Pending[] = [];
  /** The filter text on screen, which the next reload asks for. */
  let filterNow = 0;
  /** A reload failed and nothing has landed since. */
  let reloadFailed = false;

  const reload = (): void => {
    state = reduce(state, { type: "reloadStarted" });
    model = bumped(model);
    pending.push({ kind: "reload", gen: model.gen, filter: filterNow, offset: 0 });
  };

  const respond = (step: Extract<Step, { t: "respond" }>, problems: string[]): void => {
    if (pending.length === 0) {
      reached.add("respond with nothing pending");
      return;
    }
    const [req] = pending.splice(step.pick % pending.length, 1);
    const size = sizes[req.filter];
    const before = snapshot(state);
    const priorModel = model;
    const stale = req.gen !== model.gen;
    switch (req.kind) {
      case "reload": {
        state = reduce(state, step.ok
          ? { type: "loaded", gen: req.gen, items: list(req.filter, size, 0, PAGE), total: size }
          : { type: "failed", gen: req.gen });
        model = reloadAnswered(model, req.gen, step.ok ? { filter: req.filter, size } : null);
        if (stale) {
          reached.add("stale reload answer");
          if (priorModel.phase === "ready") reached.add("stale reload answer after a newer list landed");
          if (snapshot(state) !== before) {
            problems.push(`stale: a superseded reload's ${step.ok ? "result" : "failure"} changed the state`);
          }
        } else if (!step.ok) {
          reached.add("reload fails");
          reloadFailed = true;
        } else {
          reached.add("reload lands");
          if (reloadFailed) reached.add("reload lands after a failed one");
          reloadFailed = false;
        }
        return;
      }
      case "more": {
        state = reduce(state, step.ok
          ? { type: "moreLoaded", gen: req.gen,
              items: list(req.filter, size, req.offset, PAGE), total: size }
          : { type: "moreFailed", gen: req.gen });
        const got = list(req.filter, size, req.offset, PAGE).length;
        model = moreAnswered(model, req.gen, step.ok ? { got, size } : null, LOAD_MORE_FAILED);
        if (stale) {
          reached.add("stale more answer");
          if (!step.ok) reached.add("stale more failure");
          if (priorModel.phase === "ready") reached.add("stale more answer after a newer list landed");
        } else reached.add(step.ok ? "more lands" : "more fails");
        return;
      }
      case "selectAll": {
        state = reduce(state, step.ok
          ? { type: "selectAllLoaded", gen: req.gen, items: list(req.filter, size, 0, size) }
          : { type: "selectAllFailed", gen: req.gen });
        model = selectAllAnswered(model, req.gen, step.ok ? { size } : null, SELECT_ALL_FAILED);
        if (stale) {
          reached.add("stale select-all answer");
          if (!step.ok) reached.add("stale select-all failure");
        } else reached.add(step.ok ? "select-all lands" : "select-all fails");
        return;
      }
    }
  };

  const check = (problems: string[]): void => {
    const shas = state.items.map((i) => i.sha256);
    const want = model.itemsFilter < 0 ? []
      : list(model.itemsFilter, sizes[model.itemsFilter], 0, model.shown).map((i) => i.sha256);
    if (shas.join() !== want.join()) {
      problems.push(`items: shown ${shas.length}, the model shows the first ` +
                    `${want.length} of filter ${model.itemsFilter}`);
    }
    if (state.total !== model.total) problems.push(`total: ${state.total}, model ${model.total}`);
    if (model.itemsFilter >= 0 && state.items.length > state.total) {
      problems.push(`more-total: ${state.items.length} items beyond a total of ${state.total}`);
    }
    if (state.filterGen !== model.gen) problems.push(`gen: ${state.filterGen}, model ${model.gen}`);
    if (state.phase !== model.phase) problems.push(`phase: ${state.phase}, model ${model.phase}`);
    if (listIsCurrent(state) !== isCurrentList(model)) {
      problems.push(`current: listIsCurrent ${listIsCurrent(state)}, model ${isCurrentList(model)}`);
    }
    if ((state.more?.gen ?? null) !== (model.more?.gen ?? null)) {
      problems.push(`more: ${state.more?.gen ?? "none"}, model ${model.more?.gen ?? "none"}`);
    }
    if (state.busy !== model.busy) problems.push(`busy: ${state.busy}, model ${model.busy}`);
    const selected = [...state.selected].sort().join();
    const wantSelected = [...model.selected].map((p) => file(model.itemsFilter, p).sha256).sort().join();
    if (selected !== wantSelected) {
      problems.push(`selected: ${state.selected.size} selected, the model has ${model.selected.size}`);
    }
    if (state.notice !== model.notice) problems.push(`notice: ${state.notice}, model ${model.notice}`);
  };

  {
    const problems: string[] = [];
    reload();
    check(problems);
    if (problems.length > 0) return { problems: problems.map((p) => `${p} (mount)`), reached, at: -1 };
  }

  for (const [i, step] of example.steps.entries()) {
    const problems: string[] = [];
    switch (step.t) {
      case "filter":
        state = reduce(state, { type: "filterChanged" });
        model = bumped(model);
        filterNow = step.to;
        if (pending.some((p) => p.kind === "reload" && p.gen === model.gen - 1)) {
          reached.add("keystroke with a reload in flight");
        }
        if (model.more !== null || model.busy === "select-all") {
          reached.add("keystroke with a list action in flight");
        }
        break;
      case "reload":
        if (pending.some((p) => p.kind === "reload" && p.gen === model.gen)) {
          reached.add("reload supersedes a reload in flight");
        }
        reload();
        break;
      case "more": {
        const expected = canMore(model);
        const before = state;
        state = reduce(state, { type: "moreStarted" });
        if (expected !== (state !== before)) {
          problems.push(`start: moreStarted ${expected ? "was refused" : "started"}, ` +
                        `the model says ${expected ? "start" : "refuse"}`);
        }
        if (expected) {
          pending.push({ kind: "more", gen: model.gen, filter: model.itemsFilter, offset: model.shown });
          model = { ...model, more: { gen: model.gen } };
        } else if (model.phase === "loading" && model.shown > 0) {
          reached.add("Load more refused while the filter is debouncing");
        } else if (model.busy !== null) reached.add("Load more refused while busy");
        else if (model.more !== null) reached.add("Load more refused in flight");
        break;
      }
      case "selectAll": {
        const expected = canSelectAll(model);
        const before = state;
        state = reduce(state, { type: "selectAllStarted" });
        if (expected !== (state !== before)) {
          problems.push(`start: selectAllStarted ${expected ? "was refused" : "started"}, ` +
                        `the model says ${expected ? "start" : "refuse"}`);
        }
        if (expected) {
          pending.push({ kind: "selectAll", gen: model.gen, filter: model.itemsFilter, offset: 0 });
          model = { ...model, busy: "select-all" };
        } else if (model.phase === "loading" && model.shown > 0) {
          reached.add("Select all refused while the filter is debouncing");
        } else if (isCurrentList(model) && model.more !== null) {
          reached.add("Select all refused with Load more in flight");
        } else if (model.busy !== null) reached.add("Select all refused while busy");
        break;
      }
      case "delete":
        if (model.busy !== null) break;
        state = reduce(state, { type: "deleteStarted" });
        model = { ...model, busy: "delete" };
        reached.add("delete in flight");
        break;
      case "deleteDone":
        if (model.busy !== "delete") break;
        state = reduce(state, { type: "deleteFinished", notice: "deleted" });
        model = { ...model, busy: null, notice: "deleted" };
        break;
      case "toggle": {
        if (!isCurrentList(model) || model.shown === 0) break;
        const position = step.pick % model.shown;
        state = reduce(state, { type: "toggled", sha: file(model.itemsFilter, position).sha256 });
        model = toggled(model, position);
        reached.add("toggle on the current list");
        break;
      }
      case "notice": {
        const text = `notice ${step.text}`;
        state = reduce(state, { type: "noticeShown", text });
        model = { ...model, notice: text };
        break;
      }
      case "respond":
        respond(step, problems);
        break;
    }
    check(problems);
    if (problems.length > 0) {
      return { problems: problems.map((p) => `${p} (step ${i})`), reached, at: i };
    }
  }
  pending = [];
  return { problems: [], reached, at: example.steps.length };
}
