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
  // Floors: half the lowest share over 30 unseeded reach runs, 2026-11-15.
  floors: {
    "dirty": 0.455,
    "dirty, then clean by changing back": 0.046,
    "edited, then columns releases": 0.113,
    "edited, then filter releases": 0.203,
    "edited, then remount releases": 0.061,
    "edited, then reset releases": 0.114,
    "edited, then sortClick releases": 0.202,
    "edited, then view releases": 0.119,
    "filter differs by padding only": 0.119,
    "held through loaded": 0.111,
    "held through refetch": 0.111,
    "held through saved": 0.109,
    "loaded a new saved view on clean": 0.195,
    "loaded a new saved view on dirty": 0.242,
    "refetch on dirty": 0.242,
    "reset from dirty": 0.258,
    "saved from dirty": 0.260,
    "second edit keeps the snapshot": 0.177,
    "sort cycled off": 0.122,
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
