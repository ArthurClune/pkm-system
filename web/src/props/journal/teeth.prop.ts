// pattern: Imperative Shell
// The journal property's teeth: wrong versions of the paging reducer, each of
// which the property must catch, by a report naming the property the mutant
// breaks. A mutant that survives means the property cannot see that bug.
import { expectMutantsCaught } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { exampleArb, type Example } from "./arbitraries";
import { REAL, runExample, type Reducer } from "./run";

captureFaultWarnings("journal teeth");

const NUM_RUNS = 20_000;
const TIME_LIMIT_MS = 15_000;

interface Mutant {
  reduce: Reducer;
  catches: readonly string[];
}

const MUTANTS: Record<string, Mutant> = {
  // The bug the reducer replaced: a resync zeroed the cursor before its
  // reload, so after a failure "Load older days" started over from the head.
  // On a short window the replacement is no smaller, so only `days` sees it.
  "Load older days after a failure starts from the head": {
    catches: ["never-shrinks", "days"],
    reduce: (state, event) => {
      if (event.type !== "older" || state.error === null) return REAL(state, event);
      const next = REAL({ ...state, days: [] }, event);
      return { ...next, days: state.days };
    },
  },
  "a success leaves the error": {
    catches: ["error"],
    reduce: (state, event) => {
      const next = REAL(state, event);
      return event.type === "loaded" ? { ...next, error: state.error } : next;
    },
  },
  "a superseded load's answer lands": {
    catches: ["stale"],
    reduce: (state, event) =>
      (event.type === "loaded" || event.type === "failed") && state.loading !== null
        ? REAL(state, { ...event, id: state.loading.id })
        : REAL(state, event),
  },
  "a resync reloads one batch": {
    catches: ["never-shrinks"],
    reduce: (state, event) => {
      if (event.type !== "resync") return REAL(state, event);
      const next = REAL(state, event);
      return next.loading === null ? next
        : { ...next, loading: { ...next.loading, want: 5 } };
    },
  },
};

expectMutantsCaught({
  suite: "journal property", mutants: MUTANTS, arbs: [exampleArb],
  problems: async (mutant, example: Example) => runExample(example, mutant.reduce).problems,
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
});
