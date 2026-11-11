// pattern: Imperative Shell
// The unlinked property's teeth: wrong versions of the lifecycle functions,
// each of which the property must catch, by a report naming the invariant
// the mutant breaks. A mutant that survives means the property cannot see
// that bug.
import { expectMutantsCaught } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { exampleArb, type Example } from "./unlinkedArbitraries";
import { REAL_OPS, runExample, type UnlinkedOps } from "./unlinkedRun";

captureFaultWarnings("unlinked teeth");

const NUM_RUNS = 20_000;
const TIME_LIMIT_MS = 15_000;

interface Mutant {
  ops: UnlinkedOps;
  catches: readonly string[];
}

const MUTANTS: Record<string, Mutant> = {
  "a delivered block can fail": {
    catches: ["lifecycle", "same-map", "listed", "can-link", "delivered-hidden"],
    ops: { ...REAL_OPS, withStatus: (statuses, uid, status) =>
      statuses.get(uid) === "delivered" && typeof status === "object"
        ? new Map(statuses).set(uid, status)
        : REAL_OPS.withStatus(statuses, uid, status) },
  },
  "a click can settle without a pending link": {
    catches: ["lifecycle", "same-map", "listed", "settled-count", "next-offset"],
    ops: { ...REAL_OPS, withStatus: (statuses, uid, status) =>
      status === "settled" && statuses.get(uid) === undefined
        ? new Map(statuses).set(uid, status)
        : REAL_OPS.withStatus(statuses, uid, status) },
  },
  "a pending link skips settling": {
    catches: ["lifecycle", "same-map", "delivered-hidden", "listed"],
    ops: { ...REAL_OPS, withStatus: (statuses, uid, status) =>
      status === "delivered" && statuses.get(uid) === "pending"
        ? new Map(statuses).set(uid, status)
        : REAL_OPS.withStatus(statuses, uid, status) },
  },
  "a repeated move returns a copy": {
    catches: ["same-map"],
    ops: { ...REAL_OPS, withStatus: (statuses, uid, status) => {
      const next = REAL_OPS.withStatus(statuses, uid, status);
      return next === statuses && statuses.has(uid) ? new Map(statuses) : next;
    } },
  },
  "a block mutates the map it was given": {
    catches: ["pure"],
    ops: { ...REAL_OPS, withStatus: (statuses, uid, status) => {
      const next = REAL_OPS.withStatus(statuses, uid, status);
      if (next !== statuses && statuses instanceof Map) {
        for (const [k] of statuses) { statuses.delete(k); break; }
      }
      return next;
    } },
  },
  "a settled block shows in the list": {
    catches: ["listed"],
    ops: { ...REAL_OPS, isListed: (status) => status !== "delivered" },
  },
  "the next offset ignores settled blocks": {
    catches: ["next-offset"],
    ops: { ...REAL_OPS, nextOffset: (loaded) => loaded },
  },
  "a delivered block comes back with a batch": {
    catches: ["delivered-hidden"],
    ops: { ...REAL_OPS, withoutDelivered: (groups) => [...groups] },
  },
  "a failed link cannot be retried": {
    catches: ["can-link"],
    ops: { ...REAL_OPS, canLink: (status) => status === undefined },
  },
};

expectMutantsCaught({
  suite: "unlinked property", mutants: MUTANTS, arbs: [exampleArb],
  problems: async (mutant, example: Example) => runExample(example, mutant.ops).problems,
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
});
