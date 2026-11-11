// pattern: Functional Core
// Runs one drawn example through the Linked references reducer the way
// BacklinksSection.tsx drives it, beside the model (model.ts), and checks
// every step. A fake server answers each request from a list of pages that
// changes between steps. Stops at the first step with a problem and returns
// every problem found there, each led by the invariant it breaks.
import type { Backlinks, BacklinkGroup } from "../../api/payloads";
import {
  backlinksPaging, hasMore, initialBacklinksPaging, walking,
  type BacklinksPaging, type BacklinksPagingEvent,
} from "../../components/backlinksPaging";
import type { BacklinkBatchState } from "../../components/backlinkBatchWalk";
import { showBacklinkGroups } from "../../components/groups";
import { canonicalTitleOf, pageIdOf, uidOf } from "../../test-mint";
import type { Example, Step } from "./arbitraries";
import {
  canOpenPanel, canStartWalk, modelStart, refreshAnswered, walkAnswered,
  withoutWalk, type Model,
} from "./model";

export type Reducer = (state: BacklinksPaging, event: BacklinksPagingEvent) => BacklinksPaging;
export const REAL: Reducer = backlinksPaging;

/** Pages on screen at the start, and pages one Show more batch adds. */
const FIRST = 2;
const BATCH = 2;

export interface RunResult {
  readonly problems: readonly string[];
  /** The named paths this example reached, for the suite's tally. */
  readonly reached: ReadonlySet<string>;
  /** The step the problems were found at, or the step count when none. */
  readonly at: number;
}

type Pending =
  | { readonly kind: "refresh"; readonly epoch: number; readonly limit: number }
  | { readonly kind: "walk"; readonly id: number; readonly epoch: number;
      readonly from: readonly number[]; readonly all: boolean;
      /** A refresh superseded it and the walk said so. */
      dropped: boolean };

function group(page: number): BacklinkGroup {
  return { page_id: pageIdOf(page), page_title: canonicalTitleOf(`P${page}`),
           items: [{ uid: uidOf(`tuid-${page}`), text: `t${page}` }] };
}

function batch(pages: readonly number[], totalPages: number): BacklinkBatchState {
  return { groups: showBacklinkGroups(pages.map(group)), totalPages, refTexts: {} };
}

const shownPages = (s: BacklinksPaging): number[] =>
  s.shown.groups.map((g) => Number(g.page_id));

const snapshot = (s: BacklinksPaging): string =>
  JSON.stringify({ ...s, walks: [...s.walks].sort() });

export function runExample(example: Example, reduce: Reducer = REAL): RunResult {
  const reached = new Set<string>();
  let server = Array.from({ length: example.pages }, (_, i) => i);
  let nextPage = example.pages;
  const first = server.slice(0, FIRST);
  const initial: Backlinks = {
    groups: first.map(group), total_pages: server.length, offset: 0, limit: FIRST,
  };
  let state = initialBacklinksPaging(initial);
  let model: Model = modelStart(first, server.length);
  const pending: Pending[] = [];

  const respond = (step: Extract<Step, { t: "respond" }>, problems: string[]): void => {
    if (pending.length === 0) {
      reached.add("respond with nothing pending");
      return;
    }
    const req = pending.splice(step.pick % pending.length, 1)[0];
    const before = snapshot(state);
    const prior = model;
    if (req.kind === "refresh") {
      const pages = server.slice(0, req.limit);
      state = reduce(state, step.ok
        ? { type: "refreshLoaded", epoch: req.epoch, result: batch(pages, server.length) }
        : { type: "refreshFailed", epoch: req.epoch, message: "500" });
      model = refreshAnswered(model, req.epoch, step.ok
        ? { pages, totalPages: server.length } : { message: "500" });
      if (!prior.refreshing || req.epoch !== prior.epoch) {
        reached.add(step.ok ? "stale refresh result" : "stale refresh failure");
        if (snapshot(state) !== before) {
          problems.push(`stale: a superseded refresh's ${step.ok ? "result" : "failure"} changed the state`);
        }
      } else if (step.ok) {
        reached.add("refresh lands");
        if (prior.shown.some((p) => !pages.includes(p))) reached.add("refresh drops a group");
        if (prior.walks.size > 0) reached.add("refresh lands with walks in flight");
      } else {
        reached.add("refresh fails");
      }
      return;
    }
    const pages = server.slice(req.from.length,
                               req.from.length + (req.all ? server.length : BATCH));
    const result = [...req.from, ...pages];
    state = reduce(state, step.ok
      ? { type: "walkLoaded", id: req.id, epoch: req.epoch,
          result: batch(result, server.length) }
      : { type: "walkFailed", id: req.id, epoch: req.epoch, message: "500" });
    model = walkAnswered(model, req.id, req.epoch, step.ok
      ? { pages: result, totalPages: server.length } : { message: "500" });
    if (!prior.walks.has(req.id)) {
      reached.add("answer for a dropped walk");
      if (snapshot(state) !== before) {
        problems.push("stale: an answer for a walk no longer in flight changed the state");
      }
    } else if (req.epoch !== prior.epoch) {
      reached.add(step.ok ? "walk result from an old epoch" : "walk failure from an old epoch");
      if (prior.refreshing) reached.add("old walk answers during a refresh");
    } else if (step.ok) {
      reached.add("walk lands");
      if (prior.walks.size > 1) reached.add("walk lands beside another");
      if (prior.shown.length !== model.shown.length &&
          prior.shown.length > req.from.length) reached.add("walk merges onto groups another walk added");
    } else {
      reached.add("walk fails");
    }
    if (prior.walks.size === 1 && step.ok === false && req.epoch === prior.epoch) {
      reached.add("last walk fails");
    }
  };

  const check = (problems: string[]): void => {
    const pages = shownPages(state);
    if (pages.join() !== model.shown.join()) {
      problems.push(`shown: ${pages.join(" ")}, model ${model.shown.join(" ")}`);
    }
    if (new Set(pages).size !== pages.length) {
      problems.push(`unique: a page shows twice in ${pages.join(" ")}`);
    }
    if (state.shown.totalPages !== model.totalPages) {
      problems.push(`total: ${state.shown.totalPages}, model ${model.totalPages}`);
    }
    if (state.epoch !== model.epoch) problems.push(`epoch: ${state.epoch}, model ${model.epoch}`);
    if (state.refreshing !== model.refreshing) {
      problems.push(`refreshing: ${state.refreshing}, model ${model.refreshing}`);
    }
    if (state.refreshError !== model.refreshError) {
      problems.push(`refresh-error: ${state.refreshError}, model ${model.refreshError}`);
    }
    if ([...state.walks].sort().join() !== [...model.walks].sort().join()) {
      problems.push(`walks: ${[...state.walks].join(" ")}, model ${[...model.walks].join(" ")}`);
    }
    if (walking(state) !== model.walks.size > 0) {
      problems.push(`walking: ${walking(state)}, model ${model.walks.size > 0}`);
    }
    if (state.walkError !== model.walkError) {
      problems.push(`walk-error: ${state.walkError}, model ${model.walkError}`);
    }
    if (state.panelOpen !== model.panelOpen) {
      problems.push(`panel: ${state.panelOpen}, model ${model.panelOpen}`);
    }
    if (hasMore(state) !== pages.length < model.totalPages) {
      problems.push(`has-more: ${hasMore(state)}, model ${pages.length < model.totalPages}`);
    }
  };

  for (const [i, step] of example.steps.entries()) {
    const problems: string[] = [];
    switch (step.t) {
      case "walk": {
        const expected = canStartWalk(model);
        const before = state;
        state = reduce(state, { type: "walkStarted" });
        const id = [...state.walks].find((w) => !before.walks.has(w));
        if (expected !== (id !== undefined)) {
          problems.push(`start: walkStarted ${expected ? "was refused" : "started"}, ` +
                        `the model says ${expected ? "start" : "refuse"}`);
          break;
        }
        if (id === undefined) {
          reached.add("walk refused during a refresh");
          break;
        }
        if (model.walks.size > 0) reached.add("two walks in flight");
        if (model.walkError !== null) reached.add("a new walk clears the walk error");
        model = { ...model, walks: new Set(model.walks).add(id), walkError: null };
        pending.push({ kind: "walk", id, epoch: model.epoch, from: model.shown,
                       all: step.all, dropped: false });
        break;
      }
      case "refresh":
        if (model.refreshing) reached.add("refresh supersedes a refresh");
        if (model.refreshError !== null) reached.add("refresh clears the refresh error");
        state = reduce(state, { type: "refreshStarted" });
        model = { ...model, epoch: model.epoch + 1, refreshing: true, refreshError: null };
        pending.push({ kind: "refresh", epoch: model.epoch, limit: step.limit });
        break;
      case "panelOpen": {
        const expected = canOpenPanel(model);
        const before = state;
        state = reduce(state, { type: "panelOpened" });
        if (expected !== (state !== before)) {
          problems.push(`panel: panelOpened ${expected ? "was refused" : "opened"}, ` +
                        `the model says ${expected ? "open" : "refuse"}`);
          break;
        }
        if (expected) model = { ...model, panelOpen: true };
        else if (model.refreshing) reached.add("panel refused during a refresh");
        break;
      }
      case "panelClose":
        state = reduce(state, { type: "panelClosed" });
        model = { ...model, panelOpen: false };
        break;
      case "drop":
        if (server.length === 0) break;
        server = server.filter((_, at) => at !== step.pick % server.length);
        break;
      case "add":
        server = [...server, nextPage];
        nextPage += 1;
        break;
      case "respond":
        respond(step, problems);
        break;
      case "dropWalk": {
        const old = pending.filter((p): p is Extract<Pending, { kind: "walk" }> =>
          p.kind === "walk" && !p.dropped && p.epoch !== model.epoch &&
          model.walks.has(p.id));
        if (old.length === 0) break;
        const req = old[step.pick % old.length];
        req.dropped = true;
        state = reduce(state, { type: "walkDropped", id: req.id });
        model = withoutWalk(model, req.id);
        reached.add("walk dropped by its own stale check");
        break;
      }
    }
    check(problems);
    if (problems.length > 0) {
      return { problems: problems.map((p) => `${p} (step ${i})`), reached, at: i };
    }
  }
  return { problems: [], reached, at: example.steps.length };
}
