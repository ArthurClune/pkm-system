// pattern: Imperative Shell
// The cell editor property: a small grid's drawn values and editable cells,
// and a drawn sequence of clicks, typing, Enter, Esc, clicks elsewhere and
// Tabs, run through stepEditor and neighbourCell beside the model
// (cellRun.ts), and every step is checked. Pure: no server, no DOM.
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
import { type CellExample, cellExampleArb } from "./cellArbitraries";
import { runCellExample } from "./cellRun";

captureFaultWarnings("table cell editor");

/** Examples per gate run, sized so this file takes about 4 seconds inside
 * `proptest/check.sh web`, where the property measured about 75,000
 * examples a second. */
export const NUM_RUNS = 300_000;
const PROPERTY_LIMIT_MS = 15_000;

const show = ([example]: [CellExample]): string =>
  `counterexample: values ${JSON.stringify(example.values)}\n`
  + `order ${JSON.stringify(example.order)}\nsteps\n${
    example.steps.map((s, i) => `  ${i} ${JSON.stringify(s)}`).join("\n")}`;

test("table cell editor property", async () => {
  await checkGateProperty({
    suite: "table cell editor property", file: "tables", arbs: [cellExampleArb],
    predicate: async (example: CellExample) => {
      const run = runCellExample(example);
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
    "cancel a changed draft": 0.036,
    "idle event ignored": 0.464,
    "open the same cell while editing": 0.062,
    "open while editing another cell": 0.211,
    "reopen a written cell": 0.036,
    "skip unchanged": 0.352,
    "tab from a cell not editable": 0.136,
    "tab to null": 0.183,
    "tab to the next row": 0.026,
    "write keeps an inner newline": 0.059,
    "write on commit": 0.036,
    "write on open": 0.057,
    "write on outside": 0.037,
    "write on tab": 0.069,
  },
};

// The tally is drawn from its own run of the same seed, so counting never
// sits inside the property under test, where shrinking would recount.
test("table cell editor reach", async () => {
  const tally: Tally = new Map();
  await fc.assert(fc.asyncProperty(cellExampleArb, async (example) => {
    bump(tally, EXAMPLES);
    for (const label of runCellExample(example).reached) bump(tally, label);
  }), { numRuns: NUM_RUNS / 10, seed: SEED });
  console.log(showTally("table cell editor property", tally, EXAMPLES));
  judgeReach("table cell editor property", tally, REACH);
});
