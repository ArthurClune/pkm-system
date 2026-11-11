// pattern: Imperative Shell
// The Linked references paging property: a drawn server and a drawn sequence
// of Show more and load-all walks, sync refreshes, panel clicks, server
// changes and answers run through the paging reducer beside the model
// (run.ts), and every step is checked. Pure: no server, no DOM.
//
// A failure prints the seed, the path, the shrunk example, every problem at
// the first failing step and a replay line. The tally of what the examples
// reached is printed after the reach run.
import fc from "fast-check";
import { test } from "vitest";
import { SEED } from "../env";
import { checkGateProperty, EXAMPLES, judgeReach } from "../gate";
import { bump, type Reach, showTally, type Tally } from "../reach";
import { captureFaultWarnings } from "../warningsCapture";
import { exampleArb, type Example } from "./arbitraries";
import { runExample } from "./run";

captureFaultWarnings("backlinks");

/** Examples per gate run. */
export const NUM_RUNS = 30_000;
const PROPERTY_LIMIT_MS = 40_000;

const show = ([example]: [Example]): string =>
  `counterexample: ${example.pages} pages\nsteps\n${
    example.steps.map((s, i) => `  ${i} ${JSON.stringify(s)}`).join("\n")}`;

test("backlinks paging property", async () => {
  await checkGateProperty({
    suite: "backlinks property", file: "backlinks", arbs: [exampleArb],
    predicate: async (example: Example) => {
      const run = runExample(example);
      if (run.problems.length > 0) throw new Error(run.problems.join("\n"));
    },
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, show,
  });
});

/** Where each label must stay above its share of EXAMPLES. */
const REACH: Reach = {
  per: EXAMPLES,
  // Floors: half the lowest share over 20 unseeded gate runs, 2026-11-11.
  floors: {
    "a new walk clears the walk error": 0.133,
    "answer for a dropped walk": 0.047,
    "last walk fails": 0.13,
    "old walk answers during a refresh": 0.158,
    "panel refused during a refresh": 0.13,
    "refresh clears the refresh error": 0.141,
    "refresh drops a group": 0.302,
    "refresh fails": 0.18,
    "refresh lands": 0.37,
    "refresh lands with walks in flight": 0.108,
    "refresh supersedes a refresh": 0.242,
    "stale refresh failure": 0.07,
    "stale refresh result": 0.194,
    "two walks in flight": 0.232,
    "walk dropped by its own stale check": 0.057,
    "walk fails": 0.169,
    "walk failure from an old epoch": 0.06,
    "walk lands": 0.337,
    "walk lands beside another": 0.156,
    "walk merges onto groups another walk added": 0.011,
    "walk refused during a refresh": 0.278,
    "walk result from an old epoch": 0.179,
  },
};

// The tally is drawn from its own run of the same seed, so counting never
// sits inside the property under test, where shrinking would recount.
test("backlinks paging reach", async () => {
  const tally: Tally = new Map();
  await fc.assert(fc.asyncProperty(exampleArb, async (example) => {
    bump(tally, EXAMPLES);
    for (const label of runExample(example).reached) bump(tally, label);
  }), { numRuns: NUM_RUNS / 10, seed: SEED });
  console.log(showTally("backlinks property", tally, EXAMPLES));
  judgeReach("backlinks property", tally, REACH);
});
