// pattern: Imperative Shell
// The journal property's teeth: wrong versions of the paging reducer, each of
// which the property must catch, by a report naming the property the mutant
// breaks. A mutant that survives means the property cannot see that bug.
import fc from "fast-check";
import { expect, test } from "vitest";
import { SEED } from "../env";
import { captureFaultWarnings } from "../warningsCapture";
import { exampleArb } from "./arbitraries";
import { REAL, runExample, type Reducer } from "./run";

captureFaultWarnings("journal teeth");

const NUM_RUNS = 20_000;
const TIME_LIMIT_MS = 15_000;

class PropertyReport extends Error {}

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

for (const [name, { reduce, catches }] of Object.entries(MUTANTS)) {
  test(`the journal property catches: ${name}`, async () => {
    const details = await fc.check(fc.asyncProperty(exampleArb, async (example) => {
      const problems = runExample(example, reduce).problems;
      if (problems.length > 0) throw new PropertyReport(problems.join("\n"));
    }), {
      numRuns: NUM_RUNS, seed: SEED, endOnFailure: true,
      interruptAfterTimeLimit: TIME_LIMIT_MS,
    });
    expect(details.failed, `mutant survived ${details.numRuns} runs` +
      ` (seed ${details.seed}): ${name}`).toBe(true);
    const error = details.errorInstance;
    expect(error instanceof PropertyReport, `mutant caught by a thrown error, not a property` +
      ` report (seed ${details.seed}): ${name}: ${String(error)}`).toBe(true);
    const lines = (error as PropertyReport).message.split("\n");
    expect(lines.some((line) => catches.some((p) => line.startsWith(`${p}: `))),
           `mutant caught, but not by ${catches.join(" or ")} (seed ${details.seed}):` +
           ` ${name}:\n${lines.join("\n")}`).toBe(true);
  });
}
