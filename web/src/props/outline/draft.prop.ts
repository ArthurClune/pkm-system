// @vitest-environment jsdom
// pattern: Imperative Shell
// The outline draft property: one block in the real editor (useOutline and
// EditableBlockTree in jsdom) takes a random interleaving of typing, erasing,
// debounce ticks, remote edits, replays landing through an authoritative
// read, a flush-and-splice command, undo, blur and refocus. After every step
// the editor must agree with draftModel.ts: the outline holds a pending draft
// exactly when the model does, the textarea shows that draft or else the
// tree's text, every flush hashes the text its draft was typed over, and a
// conflict arises only under a remote edit or replay.
//
// A failure prints the seed, the path, the shrunk example and a replay line.
import fc from "fast-check";
import { test } from "vitest";
import { PATH, SEED } from "../env";
import { captureFaultWarnings } from "../warningsCapture";
import { runDraftExample } from "./draftHarness";
import { draftExampleArb, type DraftExample } from "./draftModel";

captureFaultWarnings("outline draft");

/** Examples per gate run, sized so this file takes about 16 seconds: run
 * alone, clean runs measured about 190 examples a second, each rendering the
 * editor afresh. */
export const NUM_RUNS = 3_000;
/** The whole property, shrinking included; see outline.prop.ts for how a cut
 * off reads. */
const PROPERTY_LIMIT_MS = 45_000;

function report(details: fc.RunDetails<[DraftExample]>): string {
  const counterexample = details.counterexample;
  const shown = counterexample === null ? "none"
    : `start ${JSON.stringify(counterexample[0].start)}\ncommands\n${
      counterexample[0].commands.map((c, i) => `  ${i} ${JSON.stringify(c)}`).join("\n")}`;
  const error = details.errorInstance instanceof Error
    ? details.errorInstance.message : String(details.errorInstance);
  return [
    `outline draft property failed after ${details.numRuns} runs and ` +
      `${details.numShrinks} shrinks` +
      (details.interrupted ? " (shrinking cut off at the time limit: the" +
                             " smallest counterexample so far)" : ""),
    `seed: ${details.seed}`,
    `path: ${details.counterexamplePath ?? "none"}`,
    `counterexample: ${shown}`,
    `error: ${error}`,
    `replay: proptest/check.sh web --seed ${details.seed}` +
      (details.counterexamplePath ? ` --path '${details.counterexamplePath}'` : "") +
      " --file outline/draft.prop.ts",
  ].join("\n");
}

test("outline draft property", async () => {
  const tally = new Map<string, number>();
  const details = await fc.check(fc.asyncProperty(draftExampleArb,
    async (example) => {
      const run = await runDraftExample(example);
      for (const label of run.labels) {
        tally.set(label, (tally.get(label) ?? 0) + 1);
      }
      if (run.problems.length > 0) throw new Error(run.problems.join("\n"));
    }), {
    numRuns: NUM_RUNS, seed: SEED, path: PATH,
    interruptAfterTimeLimit: PROPERTY_LIMIT_MS, markInterruptAsFailure: false,
  });
  console.log(`outline draft tally after ${details.numRuns} runs: ${
    [...tally].sort(([a], [b]) => a.localeCompare(b))
      .map(([label, n]) => `${label}=${n}`).join(" ")}`);
  if (details.failed && details.counterexample !== null) {
    const text = report(details);
    console.error(text);
    throw new Error(text);
  }
  if (details.interrupted) {
    const text = `outline draft property ran out of its time budget after ` +
      `${details.numRuns} of ${NUM_RUNS} runs (no failure found): a budget ` +
      `problem, not a finding\nseed: ${details.seed}`;
    console.error(text);
    throw new Error(text);
  }
  if (details.failed) {
    const text = report(details);
    console.error(text);
    throw new Error(text);
  }
});
