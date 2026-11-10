// pattern: Imperative Shell
// The Journal paging property: a drawn server and a drawn sequence of loads,
// resyncs, answers, StrictMode replays and remounts run through the paging
// reducer beside the model (run.ts), and every step is checked. Pure: no
// server, no DOM.
//
// A failure prints the seed, the path, the shrunk example, every problem at
// the first failing step and a replay line. The tally of what the examples
// reached is printed once, after the file.
import fc from "fast-check";
import { afterAll, test } from "vitest";
import { SEED } from "../env";
import { checkGateProperty } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { exampleArb, type Example } from "./arbitraries";
import { runExample } from "./run";

captureFaultWarnings("journal");

/** Examples per gate run, sized so this file takes about 12 seconds inside
 * `proptest/check.sh web`, where the property measured about 5,400 examples
 * a second. */
export const NUM_RUNS = 60_000;
const PROPERTY_LIMIT_MS = 40_000;

const tally = new Map<string, number>();
let examples = 0;

afterAll(() => {
  const rows = [...tally.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([label, n]) => `  ${label}: ${n} (${(100 * n / Math.max(1, examples)).toFixed(1)}%)`);
  console.log(`journal reach over ${examples} examples:\n${rows.join("\n")}`);
});

const show = ([example]: [Example]): string =>
  `counterexample: serverDays ${example.serverDays}\nsteps\n${
    example.steps.map((s, i) => `  ${i} ${JSON.stringify(s)}`).join("\n")}`;

test("journal paging property", async () => {
  await checkGateProperty({
    suite: "journal property", file: "journal", arbs: [exampleArb],
    predicate: async (example: Example) => {
      const run = runExample(example);
      if (run.problems.length > 0) throw new Error(run.problems.join("\n"));
    },
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, show,
  });
});

// The tally is drawn from its own run of the same seed, so counting never
// sits inside the property under test, where shrinking would recount.
test("journal paging reach", async () => {
  await fc.assert(fc.asyncProperty(exampleArb, async (example) => {
    examples += 1;
    for (const label of runExample(example).reached) tally.set(label, (tally.get(label) ?? 0) + 1);
  }), { numRuns: NUM_RUNS / 10, seed: SEED });
});
