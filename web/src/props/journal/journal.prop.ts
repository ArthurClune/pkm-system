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
import { PATH, SEED } from "../env";
import { captureFaultWarnings } from "../warningsCapture";
import { exampleArb, type Example } from "./arbitraries";
import { runExample } from "./run";

captureFaultWarnings("journal");

/** Examples per gate run, sized so this file takes about 12 seconds inside
 * `proptest/check.sh web`, where the property measured about 5,400 examples
 * a second. */
export const NUM_RUNS = 60_000;
/** The whole property, shrinking included. Cut off while shrinking, it fails
 * with the smallest counterexample so far; cut off before any failure, it
 * fails as a budget problem, never as a finding. */
const PROPERTY_LIMIT_MS = 40_000;

const tally = new Map<string, number>();
let examples = 0;

afterAll(() => {
  const rows = [...tally.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([label, n]) => `  ${label}: ${n} (${(100 * n / Math.max(1, examples)).toFixed(1)}%)`);
  console.log(`journal reach over ${examples} examples:\n${rows.join("\n")}`);
});

function report(details: fc.RunDetails<[Example]>): string {
  const ce = details.counterexample;
  const shown = ce === null ? "none"
    : `serverDays ${ce[0].serverDays}\nsteps\n${
      ce[0].steps.map((s, i) => `  ${i} ${JSON.stringify(s)}`).join("\n")}`;
  const error = details.errorInstance instanceof Error
    ? details.errorInstance.message : String(details.errorInstance);
  return [
    `journal property failed after ${details.numRuns} runs and ${details.numShrinks} shrinks` +
      (details.interrupted ? " (shrinking cut off at the time limit: the smallest" +
                             " counterexample so far)" : ""),
    `seed: ${details.seed}`,
    `path: ${details.counterexamplePath ?? "none"}`,
    `counterexample: ${shown}`,
    `error: ${error}`,
    `replay: proptest/check.sh web --seed ${details.seed}` +
      (details.counterexamplePath ? ` --path '${details.counterexamplePath}'` : "") +
      " --file journal",
  ].join("\n");
}

test("journal paging property", () => {
  const details = fc.check(fc.property(exampleArb, (example) => {
    const run = runExample(example);
    if (run.problems.length > 0) throw new Error(run.problems.join("\n"));
  }), {
    numRuns: NUM_RUNS, seed: SEED, path: PATH,
    interruptAfterTimeLimit: PROPERTY_LIMIT_MS, markInterruptAsFailure: false,
  });
  if (details.failed && details.counterexample !== null) {
    const text = report(details);
    console.error(text);
    throw new Error(text);
  }
  if (details.interrupted) {
    const text = `journal property ran out of its time budget after ${details.numRuns} of` +
      ` ${NUM_RUNS} runs (no failure found): a budget problem, not a finding\n` +
      `seed: ${details.seed}`;
    console.error(text);
    throw new Error(text);
  }
  if (details.failed) {
    const text = report(details);
    console.error(text);
    throw new Error(text);
  }
});

// The tally is drawn from its own run of the same seed, so counting never
// sits inside the property under test, where shrinking would recount.
test("journal paging reach", () => {
  fc.assert(fc.property(exampleArb, (example) => {
    examples += 1;
    for (const label of runExample(example).reached) tally.set(label, (tally.get(label) ?? 0) + 1);
  }), { numRuns: NUM_RUNS / 10, seed: SEED });
});
