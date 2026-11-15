// pattern: Imperative Shell
// The table view property's teeth: wrong versions of the view-state machine,
// each of which the property must catch, by a report naming the invariant
// the mutant breaks. A mutant that survives means the property cannot see
// that bug.
import { expectMutantsCaught } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { viewExampleArb, type ViewExample } from "./arbitraries";
import { REAL, runViewExample, type ViewMachine } from "./viewRun";

captureFaultWarnings("table view teeth");

const NUM_RUNS = 20_000;
const TIME_LIMIT_MS = 15_000;

interface Mutant extends ViewMachine {
  catches: readonly string[];
}

const step = (wrong: ViewMachine["step"]): ViewMachine => ({ ...REAL, step: wrong });

const MUTANTS: Record<string, Mutant> = {
  "a refetch overwrites a changed live view": {
    catches: ["loaded-keeps-dirty", "live"],
    ...step((s, e) => e.kind === "loaded" ? { ...s, saved: e.saved, live: e.saved }
      : REAL.step(s, e)),
  },
  "a refetch leaves an untouched live view on the old saved one": {
    catches: ["live"],
    ...step((s, e) => e.kind === "loaded" ? { ...s, saved: e.saved } : REAL.step(s, e)),
  },
  "a second edit retakes the held rows": {
    catches: ["frozen"],
    ...step((s, e) => e.kind === "edited" ? { ...s, frozen: e.visibleIds }
      : REAL.step(s, e)),
  },
  "a sort click keeps the held rows": {
    catches: ["frozen"],
    ...step((s, e) => e.kind === "sortClick" ? { ...REAL.step(s, e), frozen: s.frozen }
      : REAL.step(s, e)),
  },
  "Save releases the held rows": {
    catches: ["frozen"],
    ...step((s, e) => e.kind === "saved" ? { ...REAL.step(s, e), frozen: null }
      : REAL.step(s, e)),
  },
  "a refetch releases the held rows": {
    catches: ["frozen"],
    ...step((s, e) => e.kind === "loaded" ? { ...REAL.step(s, e), frozen: null }
      : REAL.step(s, e)),
  },
  "a descending sort click wraps to ascending": {
    catches: ["live"],
    ...step((s, e) => {
      const next = REAL.step(s, e);
      return e.kind === "sortClick" && next.live.sort === null
        ? { ...next, live: { ...next.live, sort: { col: e.col, dir: "asc" } } } : next;
    }),
  },
  "padding in the filter counts as a change": {
    catches: ["dirty", "clean"],
    ...REAL,
    isDirty: (s) => REAL.isDirty(s) || s.live.filter !== s.saved.filter,
  },
  "column order is ignored": {
    catches: ["dirty"],
    ...REAL,
    isDirty: (s) => REAL.isDirty({
      ...s, live: { ...s.live, columns: [...s.live.columns].sort() },
      saved: { ...s.saved, columns: [...s.saved.columns].sort() },
    }),
  },
};

expectMutantsCaught({
  suite: "table view property", mutants: MUTANTS, arbs: [viewExampleArb],
  problems: async (mutant, example: ViewExample) => runViewExample(example, mutant).problems,
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
});
