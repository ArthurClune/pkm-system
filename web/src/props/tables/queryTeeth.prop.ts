// pattern: Imperative Shell
// The query view property's teeth: wrong versions of stepQueryView,
// showQuery and holdRecords, each of which the property must catch, by a
// report naming the invariant the mutant breaks. A mutant that survives
// means the property cannot see that bug.
import { queryColumns, shownRows } from "../../tables/queryView";
import { expectMutantsCaught } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { queryExampleArb, type QueryExample } from "./queryArbitraries";
import { REAL_QUERY, runQueryExample, type QueryMachine } from "./queryRun";

captureFaultWarnings("query view teeth");

const NUM_RUNS = 20_000;
const TIME_LIMIT_MS = 15_000;

interface Mutant extends QueryMachine {
  catches: readonly string[];
}

const MUTANTS: Record<string, Mutant> = {
  "a second edit retakes the snapshot": {
    catches: ["hold-columns", "hold-view", "hold-keys"],
    ...REAL_QUERY,
    step: (s, e) => {
      const next = REAL_QUERY.step(s, e);
      return e.kind === "edited" && next.view.frozen !== null
        ? { ...next, held: e.shown } : next;
    },
  },
  "the view is not held": {
    catches: ["hold-view"],
    ...REAL_QUERY,
    show: (s, ...rest) => ({ ...REAL_QUERY.show(s, ...rest), view: s.view.live.view }),
  },
  "the columns are not held": {
    catches: ["hold-columns"],
    ...REAL_QUERY,
    show: (s, options, keys, records, held) => {
      const shown = REAL_QUERY.show(s, options, keys, records, held);
      const columns = queryColumns(s.view.live.columns, keys, s.held?.keys);
      return { ...shown, columns };
    },
  },
  "the hold covers columns the macro sets": {
    catches: ["chosen"],
    ...REAL_QUERY,
    show: (s, options, keys, records, held) => {
      const shown = REAL_QUERY.show(s, options, keys, records, held);
      if (s.held === null) return shown;
      const columns = queryColumns(s.held.columns, keys, s.held.keys);
      return { ...shown, columns,
               ...shownRows(records, columns, s.view.live, s.view.frozen, held) };
    },
  },
  "the hold covers the view the macro sets": {
    catches: ["chosen"],
    ...REAL_QUERY,
    show: (s, ...rest) => ({ ...REAL_QUERY.show(s, ...rest),
                             view: s.held?.view ?? s.view.live.view }),
  },
  "a held column finds no key in the first edit's stats": {
    catches: ["hold-keys"],
    ...REAL_QUERY,
    show: (s, options, keys, records, held) => {
      const shown = REAL_QUERY.show(s, options, keys, records, held);
      const labels = shown.columns.map((c) => c.label);
      return { ...shown, columns: queryColumns(labels, keys) };
    },
  },
  "the snapshot outlives a release": {
    catches: ["released", "held-iff-frozen"],
    ...REAL_QUERY,
    step: (s, e) => {
      const next = REAL_QUERY.step(s, e);
      return next.held === null ? { ...next, held: s.held } : next;
    },
  },
  "a refetch drops the held rows' records": {
    catches: ["hold-rows"],
    ...REAL_QUERY,
    hold: () => new Map(),
  },
};

expectMutantsCaught({
  suite: "query view property", mutants: MUTANTS, arbs: [queryExampleArb],
  problems: async (mutant, example: QueryExample) =>
    runQueryExample(example, mutant).problems,
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
});
