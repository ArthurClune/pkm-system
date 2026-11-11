// pattern: Imperative Shell
// The files property's teeth: wrong versions of the paging reducer, each of
// which the property must catch, by a report naming the invariant the mutant
// breaks. A mutant that survives means the property cannot see that bug.
import { expectMutantsCaught } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { exampleArb, type Example } from "./arbitraries";
import { REAL, runExample, type Reducer } from "./run";

captureFaultWarnings("files teeth");

const NUM_RUNS = 20_000;
const TIME_LIMIT_MS = 15_000;

interface Mutant {
  reduce: Reducer;
  catches: readonly string[];
}

const MUTANTS: Record<string, Mutant> = {
  "a superseded reload's answer lands": {
    catches: ["stale", "items", "total", "phase", "current"],
    reduce: (state, event) =>
      event.type === "loaded" || event.type === "failed"
        ? REAL(state, { ...event, gen: state.filterGen })
        : REAL(state, event),
  },
  "a superseded Load more appends its page": {
    catches: ["items", "total"],
    reduce: (state, event) =>
      event.type === "moreLoaded" && state.more?.gen === event.gen &&
        event.gen !== state.filterGen
        ? { ...state, more: null, items: [...state.items, ...event.items],
            total: event.total }
        : REAL(state, event),
  },
  "a superseded Select all selects its files": {
    catches: ["items", "selected"],
    reduce: (state, event) =>
      event.type === "selectAllLoaded" && state.busy === "select-all" &&
        event.gen !== state.filterGen
        ? { ...state, busy: null, items: event.items,
            selected: new Set(event.items.map((i) => i.sha256)) }
        : REAL(state, event),
  },
  "a keystroke leaves the generation to the reload": {
    catches: ["gen", "current", "phase"],
    reduce: (state, event) =>
      event.type === "filterChanged" ? state : REAL(state, event),
  },
  "Select all starts from a list the filter has left": {
    catches: ["start", "busy"],
    reduce: (state, event) =>
      event.type === "selectAllStarted" && state.phase === "loading" &&
        state.busy === null
        ? { ...state, busy: "select-all" }
        : REAL(state, event),
  },
  "a failed Load more keeps its slot": {
    catches: ["more"],
    reduce: (state, event) =>
      event.type === "moreFailed" && state.more?.gen === event.gen
        ? state : REAL(state, event),
  },
  "a superseded Select all leaves the view busy": {
    catches: ["busy"],
    reduce: (state, event) =>
      (event.type === "selectAllLoaded" || event.type === "selectAllFailed") &&
        event.gen !== state.filterGen
        ? state : REAL(state, event),
  },
};

expectMutantsCaught({
  suite: "files property", mutants: MUTANTS, arbs: [exampleArb],
  problems: async (mutant, example: Example) => runExample(example, mutant.reduce).problems,
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
});
