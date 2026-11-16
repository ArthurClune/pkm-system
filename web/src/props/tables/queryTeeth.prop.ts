// pattern: Imperative Shell
// The query view property's teeth: wrong versions of stepQueryView,
// showQuery and holdRecords, built into a query block by makeQueryBlock,
// and wrong versions of the block's own fetch rules, each of which the
// property must catch, by a report naming the invariant the mutant breaks.
// A mutant that survives means the property cannot see that bug.
import {
  makeQueryBlock, QUERY_BLOCK, REAL_QUERY, type QueryBlock, type QueryMachine,
} from "../../tables/queryBlock";
import { queryColumns, shownRows } from "../../tables/queryView";
import { expectMutantsCaught } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { queryExampleArb, type QueryExample } from "./queryArbitraries";
import { runQueryExample } from "./queryRun";

captureFaultWarnings("query view teeth");

const NUM_RUNS = 20_000;
const TIME_LIMIT_MS = 15_000;

interface Mutant extends QueryBlock {
  catches: readonly string[];
}

/** A block over a wrong view function. */
const viewMutant = (catches: readonly string[],
                    wrong: Partial<QueryMachine>): Mutant =>
  ({ catches, ...makeQueryBlock({ ...REAL_QUERY, ...wrong }) });

const MUTANTS: Record<string, Mutant> = {
  "a second edit retakes the snapshot": viewMutant(
    ["hold-columns", "hold-view", "hold-keys"], {
    step: (s, e) => {
      const next = REAL_QUERY.step(s, e);
      return e.kind === "edited" && next.view.frozen !== null
        ? { ...next, held: e.shown } : next;
    },
  }),
  "the view is not held": viewMutant(["hold-view"], {
    show: (s, ...rest) => ({ ...REAL_QUERY.show(s, ...rest), view: s.view.live.view }),
  }),
  "the columns are not held": viewMutant(["hold-columns"], {
    show: (s, options, keys, records, held) => {
      const shown = REAL_QUERY.show(s, options, keys, records, held);
      const columns = queryColumns(s.view.live.columns, keys, s.held?.keys);
      return { ...shown, columns };
    },
  }),
  "the hold covers columns the macro sets": viewMutant(["chosen"], {
    show: (s, options, keys, records, held) => {
      const shown = REAL_QUERY.show(s, options, keys, records, held);
      if (s.held === null) return shown;
      const columns = queryColumns(s.held.columns, keys, s.held.keys);
      return { ...shown, columns,
               ...shownRows(records, columns, s.view.live, s.view.frozen, held) };
    },
  }),
  "the hold covers the view the macro sets": viewMutant(["chosen"], {
    show: (s, ...rest) => ({ ...REAL_QUERY.show(s, ...rest),
                             view: s.held?.view ?? s.view.live.view }),
  }),
  "a held column finds no key in the first edit's stats": viewMutant(
    ["hold-keys"], {
    show: (s, options, keys, records, held) => {
      const shown = REAL_QUERY.show(s, options, keys, records, held);
      const labels = shown.columns.map((c) => c.label);
      return { ...shown, columns: queryColumns(labels, keys) };
    },
  }),
  "the snapshot outlives a release": viewMutant(
    ["released", "held-iff-frozen"], {
    step: (s, e) => {
      const next = REAL_QUERY.step(s, e);
      return next.held === null ? { ...next, held: s.held } : next;
    },
  }),
  "a refetch drops the held rows' records": viewMutant(["hold-rows"], {
    hold: () => new Map(),
  }),
  "a fetch out is started again": {
    catches: ["fetch-twice"], ...QUERY_BLOCK,
    groupsFetchDue: (s, load) =>
      QUERY_BLOCK.groupsFetchDue({ ...s, groupsTried: null }, load),
  },
  "a fetch starts though the records carried the groups": {
    catches: ["fetch-carried"], ...QUERY_BLOCK,
    groupsFetchDue: (s, load) =>
      QUERY_BLOCK.groupsFetchDue({ ...s, groupsFor: null }, load),
  },
  "a fetch starts before the records that may carry the groups": {
    catches: ["fetch-early"], ...QUERY_BLOCK,
    groupsFetchDue: (s, load) =>
      QUERY_BLOCK.groupsFetchDue({ ...s, recordsFor: load }, load),
  },
  "a fetch starts outside the blocks view": {
    catches: ["fetch-unwanted"], ...QUERY_BLOCK,
    groupsFetchDue: (s, load) => s.groupsFor !== load
      && s.groupsTried !== load
      && (s.options.view === "blocks" || s.recordsFor === load),
  },
  "records that carry the groups leave the fetch out its answer": {
    catches: ["groups-replaced"], ...QUERY_BLOCK,
    step: (s, e) => {
      const next = QUERY_BLOCK.step(s, e);
      return e.kind === "recordsLanded" && e.payload.groups !== null
        && QUERY_BLOCK.wantsBlocks(next)
        ? { ...next, groupsTried: s.groupsTried } : next;
    },
  },
  "a groups answer is taken for any load": {
    catches: ["groups-replaced"], ...QUERY_BLOCK,
    step: (s, e) => e.kind === "groupsLanded"
      ? { ...s, groups: e.groups, groupsFor: e.load, groupsError: null }
      : QUERY_BLOCK.step(s, e),
  },
  "leaving the blocks view keeps the fetch tried": {
    catches: ["stall"], ...QUERY_BLOCK,
    step: (s, e) => {
      const next = QUERY_BLOCK.step(s, e);
      return QUERY_BLOCK.wantsBlocks(next) || e.kind === "recordsLanded"
        ? next : { ...next, groupsTried: s.groupsTried };
    },
  },
};

expectMutantsCaught({
  suite: "query view property", mutants: MUTANTS, arbs: [queryExampleArb],
  problems: async (mutant, example: QueryExample) =>
    runQueryExample(example, mutant).problems,
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
});
