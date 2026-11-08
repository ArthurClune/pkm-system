// pattern: Imperative Shell
// The assistant panel's chat machine property: drawn action lists (the
// user's actions and every way a request can settle, freely interleaved)
// run through the real reducer against a simulated server, and every step is
// checked against the docs model (run.ts names the invariants). Pure: no
// server, no DOM.
//
// A failure prints the seed, the path, the shrunk action list, the reducer's
// trace of it, the problems and a replay line. The tally of what the
// examples reached is printed once, after the file.
import fc from "fast-check";
import { afterAll, test } from "vitest";
import { PATH, SEED } from "../env";
import { captureFaultWarnings } from "../warningsCapture";
import { actionsArb, type Action } from "./arbitraries";
import { REAL, runActions, type Tally } from "./run";

captureFaultWarnings("assistant");

/** Examples per gate run, sized so this file takes about 20 seconds inside
 * `proptest/check.sh web`: alone it measured about 65,000 examples a
 * second. */
export const NUM_RUNS = 1_300_000;
/** The whole property, shrinking included. Cut off while shrinking, it fails
 * with the smallest counterexample so far; cut off before any failure, it
 * fails as a budget problem, never as a finding. */
const PROPERTY_LIMIT_MS = 60_000;

const tally: Tally = new Map();

afterAll(() => {
  const rows = [...tally.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `  ${k}: ${n}`);
  console.log(`assistant property tally (every run, shrinks included):\n${rows.join("\n")}`);
});

function report(details: fc.RunDetails<[Action[]]>): string {
  const counterexample = details.counterexample;
  const error = details.errorInstance instanceof Error
    ? details.errorInstance.message : String(details.errorInstance);
  const shown = counterexample === null ? "none"
    : counterexample[0].map((a, i) => `  ${i} ${JSON.stringify(a)}`).join("\n");
  const trace = counterexample === null ? []
    : runActions(counterexample[0]).trace.map((t) => `  ${t}`);
  return [
    `assistant property failed after ${details.numRuns} runs and ${details.numShrinks} shrinks` +
      (details.interrupted ? " (shrinking cut off at the time limit: the smallest" +
                             " counterexample so far)" : ""),
    `seed: ${details.seed}`,
    `path: ${details.counterexamplePath ?? "none"}`,
    `actions:\n${shown}`,
    `trace:\n${trace.join("\n")}`,
    `error: ${error}`,
    `replay: proptest/check.sh web --seed ${details.seed}` +
      (details.counterexamplePath ? ` --path '${details.counterexamplePath}'` : "") +
      " --file assistant/assistant.prop.ts",
  ].join("\n");
}

test("assistant chat machine property", () => {
  const details = fc.check(fc.property(actionsArb, (actions) => {
    const { problems } = runActions(actions, REAL, tally);
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }), {
    numRuns: NUM_RUNS, seed: SEED, path: PATH,
    interruptAfterTimeLimit: PROPERTY_LIMIT_MS, markInterruptAsFailure: false,
  });
  console.log(`assistant property: ${details.numRuns} runs`);
  // A failure keeps failed set when the time limit cuts its shrinking off,
  // with the smallest counterexample so far. Cut off before any failure,
  // fast-check reports interrupted, and failed as well if no example had
  // finished, but with no counterexample: either way that is the budget.
  if (details.failed && details.counterexample !== null) {
    const text = report(details);
    console.error(text);
    throw new Error(text);
  }
  if (details.interrupted) {
    const text = `assistant property ran out of its time budget after ${details.numRuns} of` +
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
