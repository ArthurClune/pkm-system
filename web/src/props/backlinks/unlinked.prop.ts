// pattern: Imperative Shell
// The Unlinked references lifecycle property: a drawn sequence of attempted
// status moves on a few blocks, run through withStatus and the functions
// that read its map beside the model (unlinkedRun.ts), every step checked.
// Pure: no server, no DOM.
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
import { exampleArb, type Example } from "./unlinkedArbitraries";
import { runExample } from "./unlinkedRun";

captureFaultWarnings("unlinked");

/** Examples per gate run. */
export const NUM_RUNS = 30_000;
const PROPERTY_LIMIT_MS = 40_000;

const show = ([example]: [Example]): string =>
  `counterexample: ${example.loaded} loaded\nsteps\n${
    example.steps.map((s, i) => `  ${i} ${JSON.stringify(s)}`).join("\n")}`;

test("unlinked lifecycle property", async () => {
  await checkGateProperty({
    suite: "unlinked property", file: "backlinks", arbs: [exampleArb],
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
    "delivered beside settled": 0.026,
    "delivered stays delivered": 0.052,
    "delivery fails after settle": 0.12,
    "error a to error": 0.247,
    "error a to pending": 0.252,
    "error b to error": 0.25,
    "error b to pending": 0.249,
    "error message replaced": 0.309,
    "error retried": 0.332,
    "move refused": 0.454,
    "move repeated": 0.354,
    "none to error": 0.444,
    "none to pending": 0.338,
    "pending to error": 0.311,
    "pending to settled": 0.227,
    "settled to delivered": 0.069,
    "settled to error": 0.12,
  },
};

// The tally is drawn from its own run of the same seed, so counting never
// sits inside the property under test, where shrinking would recount.
test("unlinked lifecycle reach", async () => {
  const tally: Tally = new Map();
  await fc.assert(fc.asyncProperty(exampleArb, async (example) => {
    bump(tally, EXAMPLES);
    for (const label of runExample(example).reached) bump(tally, label);
  }), { numRuns: NUM_RUNS / 10, seed: SEED });
  console.log(showTally("unlinked property", tally, EXAMPLES));
  judgeReach("unlinked property", tally, REACH);
});
