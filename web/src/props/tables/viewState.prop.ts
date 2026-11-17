// pattern: Imperative Shell
// The table view-state property: a drawn saved view and a drawn sequence of
// view changes, cell edits, Resets, Saves, refetches and remounts run
// through stepView beside the model (viewRun.ts), and every step is checked.
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
import { viewExampleArb, type ViewExample } from "./arbitraries";
import { runViewExample } from "./viewRun";

captureFaultWarnings("table view");

/** Examples per gate run, sized so this file takes about 5 seconds inside
 * `proptest/check.sh web`, where the property measured about 12,000
 * examples a second. */
export const NUM_RUNS = 60_000;
const PROPERTY_LIMIT_MS = 15_000;

const show = ([example]: [ViewExample]): string =>
  `counterexample: saved ${JSON.stringify(example.saved)}\nsteps\n${
    example.steps.map((s, i) => `  ${i} ${JSON.stringify(s)}`).join("\n")}`;

test("table view-state property", async () => {
  await checkGateProperty({
    suite: "table view property", file: "tables", arbs: [viewExampleArb],
    predicate: async (example: ViewExample) => {
      const run = runViewExample(example);
      if (run.problems.length > 0) throw new Error(run.problems.join("\n"));
    },
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, show,
  });
});

/** Where each label must stay above its share of EXAMPLES. */
const REACH: Reach = {
  per: EXAMPLES,
  // Floors: half the lowest share over 30 unseeded reach runs, 2026-11-17,
  // after release joined the draws.
  floors: {
    "dirty": 0.451,
    "dirty, then clean by changing back": 0.047,
    "edited, then columns releases": 0.111,
    "edited, then filter releases": 0.194,
    "edited, then release releases": 0.058,
    "edited, then remount releases": 0.059,
    "edited, then reset releases": 0.109,
    "edited, then sortClick releases": 0.189,
    "edited, then view releases": 0.112,
    "filter differs by padding only": 0.119,
    "held through loaded": 0.101,
    "held through refetch": 0.103,
    "held through saved": 0.103,
    "loaded a new saved view on clean": 0.2,
    "loaded a new saved view on dirty": 0.239,
    "refetch on dirty": 0.239,
    "reset from dirty": 0.258,
    "saved from dirty": 0.259,
    "second edit keeps the snapshot": 0.168,
    "sort cycled off": 0.119,
  },
};

// The tally is drawn from its own run of the same seed, so counting never
// sits inside the property under test, where shrinking would recount.
test("table view-state reach", async () => {
  const tally: Tally = new Map();
  await fc.assert(fc.asyncProperty(viewExampleArb, async (example) => {
    bump(tally, EXAMPLES);
    for (const label of runViewExample(example).reached) bump(tally, label);
  }), { numRuns: NUM_RUNS / 10, seed: SEED });
  console.log(showTally("table view property", tally, EXAMPLES));
  judgeReach("table view property", tally, REACH);
});
