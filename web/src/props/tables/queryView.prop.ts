// pattern: Imperative Shell
// The query view property: drawn macro options, a first records answer and
// a sequence of reader changes, cell edits, refetches and macro edits, run
// through stepQueryView, showQuery and holdRecords as QueryResults wires
// them, beside the model (queryRun.ts); what the block shows is checked at
// every step. Pure: no server, no DOM.
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
import { queryExampleArb, type QueryExample } from "./queryArbitraries";
import { runQueryExample } from "./queryRun";

captureFaultWarnings("query view");

/** Examples per gate run, sized so this file takes about 5 seconds inside
 * `proptest/check.sh web`. */
export const NUM_RUNS = 50_000;
const PROPERTY_LIMIT_MS = 15_000;

const show = ([example]: [QueryExample]): string =>
  `counterexample: options ${JSON.stringify(example.options)}\n`
  + `first ${JSON.stringify(example.first)}\nsteps\n${
    example.steps.map((s, i) => `  ${i} ${JSON.stringify(s)}`).join("\n")}`;

test("query view property", async () => {
  await checkGateProperty({
    suite: "query view property", file: "tables", arbs: [queryExampleArb],
    predicate: async (example: QueryExample) => {
      const run = runQueryExample(example);
      if (run.problems.length > 0) throw new Error(run.problems.join("\n"));
    },
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, show,
  });
});

/** Where each label must stay above its share of EXAMPLES. */
const REACH: Reach = {
  per: EXAMPLES,
  // Floors: half the lowest share over 30 unseeded reach runs, 2026-11-16.
  floors: {
    "a second edit keeps the snapshot": 0.181,
    "columns releases a hold": 0.061,
    "filter releases a hold": 0.115,
    "held a column the load's records no longer hold": 0.1,
    "held a row the load dropped": 0.154,
    "held the table through a load whose default is blocks": 0.109,
    "held with columns the macro sets": 0.093,
    "keyed a held column by the first edit's stats": 0.12,
    "reset releases a hold": 0.061,
    "saved while held": 0.058,
    "sortClick releases a hold": 0.062,
    "view releases a hold": 0.066,
  },
};

// The tally is drawn from its own run of the same seed, so counting never
// sits inside the property under test, where shrinking would recount.
test("query view reach", async () => {
  const tally: Tally = new Map();
  await fc.assert(fc.asyncProperty(queryExampleArb, async (example) => {
    bump(tally, EXAMPLES);
    for (const label of runQueryExample(example).reached) bump(tally, label);
  }), { numRuns: NUM_RUNS / 10, seed: SEED });
  console.log(showTally("query view property", tally, EXAMPLES));
  judgeReach("query view property", tally, REACH);
});
