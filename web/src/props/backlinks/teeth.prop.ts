// pattern: Imperative Shell
// The backlinks property's teeth: wrong versions of the paging reducer, each
// of which the property must catch, by a report naming the invariant the
// mutant breaks. A mutant that survives means the property cannot see that
// bug.
import { expectMutantsCaught } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { exampleArb, type Example } from "./arbitraries";
import { REAL, runExample, type Reducer } from "./run";

captureFaultWarnings("backlinks teeth");

const NUM_RUNS = 20_000;
const TIME_LIMIT_MS = 15_000;

interface Mutant {
  reduce: Reducer;
  catches: readonly string[];
}

const MUTANTS: Record<string, Mutant> = {
  "a superseded refresh's result lands": {
    catches: ["stale", "shown", "total", "refreshing", "unique", "has-more"],
    reduce: (state, event) =>
      event.type === "refreshLoaded" && state.refreshing
        ? REAL(state, { ...event, epoch: state.epoch })
        : REAL(state, event),
  },
  "a walk from an old epoch merges its groups": {
    catches: ["shown", "total", "has-more"],
    reduce: (state, event) =>
      event.type === "walkLoaded" ? REAL(state, { ...event, epoch: state.epoch })
        : REAL(state, event),
  },
  "a walk's result replaces the groups instead of merging": {
    catches: ["shown", "total", "has-more"],
    reduce: (state, event) => {
      const next = REAL(state, event);
      return event.type === "walkLoaded" && event.epoch === state.epoch &&
        state.walks.has(event.id) ? { ...next, shown: event.result } : next;
    },
  },
  "a walk starts during a refresh": {
    catches: ["start", "walks", "walking"],
    reduce: (state, event) =>
      event.type === "walkStarted" && state.refreshing
        ? { ...REAL({ ...state, refreshing: false }, event), refreshing: true }
        : REAL(state, event),
  },
  "the panel opens during a refresh": {
    catches: ["panel"],
    reduce: (state, event) =>
      event.type === "panelOpened" && state.refreshing && !state.panelOpen
        ? { ...state, panelOpen: true } : REAL(state, event),
  },
  "a walk failure from an old epoch sets the error": {
    catches: ["walk-error"],
    reduce: (state, event) => {
      const next = REAL(state, event);
      return event.type === "walkFailed" && state.walks.has(event.id)
        ? { ...next, walkError: event.message } : next;
    },
  },
  "a walk from an old epoch stays in flight": {
    catches: ["walks", "walking"],
    reduce: (state, event) =>
      (event.type === "walkLoaded" || event.type === "walkFailed") &&
        event.epoch !== state.epoch ? state : REAL(state, event),
  },
  "a new walk keeps the last walk's error": {
    catches: ["walk-error"],
    reduce: (state, event) => {
      const next = REAL(state, event);
      return event.type === "walkStarted" && next !== state
        ? { ...next, walkError: state.walkError } : next;
    },
  },
  "an answer for a dropped walk changes the state": {
    catches: ["stale", "total", "shown", "walk-error", "has-more"],
    reduce: (state, event) =>
      (event.type === "walkLoaded" || event.type === "walkFailed") &&
        !state.walks.has(event.id)
        ? { ...state, walkError: "late" } : REAL(state, event),
  },
};

expectMutantsCaught({
  suite: "backlinks property", mutants: MUTANTS, arbs: [exampleArb],
  problems: async (mutant, example: Example) => runExample(example, mutant.reduce).problems,
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
});
