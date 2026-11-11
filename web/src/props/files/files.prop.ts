// pattern: Imperative Shell
// The Files paging property: a drawn server and a drawn sequence of filter
// keystrokes, reloads, Load more and Select all clicks and answers run
// through the paging reducer beside the model (run.ts), and every step is
// checked. Pure: no server, no DOM.
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

captureFaultWarnings("files");

/** Examples per gate run. */
export const NUM_RUNS = 30_000;
const PROPERTY_LIMIT_MS = 40_000;

const show = ([example]: [Example]): string =>
  `counterexample: sizes ${example.sizes.join(", ")}\nsteps\n${
    example.steps.map((s, i) => `  ${i} ${JSON.stringify(s)}`).join("\n")}`;

test("files paging property", async () => {
  await checkGateProperty({
    suite: "files property", file: "files", arbs: [exampleArb],
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
    "Load more refused in flight": 0.029,
    "Load more refused while busy": 0.115,
    "Load more refused while the filter is debouncing": 0.226,
    "Select all refused while busy": 0.11,
    "Select all refused while the filter is debouncing": 0.226,
    "Select all refused with Load more in flight": 0.029,
    "delete in flight": 0.256,
    "keystroke with a list action in flight": 0.087,
    "keystroke with a reload in flight": 0.253,
    "more fails": 0.02,
    "more lands": 0.078,
    "reload fails": 0.161,
    "reload lands": 0.396,
    "reload lands after a failed one": 0.088,
    "reload supersedes a reload in flight": 0.217,
    "select-all fails": 0.021,
    "select-all lands": 0.073,
    "stale more answer": 0.057,
    "stale more answer after a newer list landed": 0.006,
    "stale more failure": 0.01,
    "stale reload answer": 0.3,
    "stale reload answer after a newer list landed": 0.058,
    "stale select-all answer": 0.057,
    "stale select-all failure": 0.011,
    "toggle on the current list": 0.138,
  },
};

// The tally is drawn from its own run of the same seed, so counting never
// sits inside the property under test, where shrinking would recount.
test("files paging reach", async () => {
  const tally: Tally = new Map();
  await fc.assert(fc.asyncProperty(exampleArb, async (example) => {
    bump(tally, EXAMPLES);
    for (const label of runExample(example).reached) bump(tally, label);
  }), { numRuns: NUM_RUNS / 10, seed: SEED });
  console.log(showTally("files property", tally, EXAMPLES));
  judgeReach("files property", tally, REACH);
});
