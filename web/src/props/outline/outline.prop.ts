// pattern: Imperative Shell
// The outline edit command property: a random start tree takes a random
// sequence of the real outline commands (run.ts), with undo and redo among
// them, and every step and the whole history are checked (checks.ts). Pure:
// no server, no DOM.
//
// A failure prints the seed, the path, the shrunk start tree and command
// list, every problem the checks found and a replay line.
import fc from "fast-check";
import { test } from "vitest";
import type { BlockNode } from "../../api/payloads";
import { PATH, SEED } from "../env";
import { sequenceArb, type Command } from "./arbitraries";
import { sequenceProblems } from "./checks";
import { runSequence } from "./run";
import { captureFaultWarnings } from "../warningsCapture";

captureFaultWarnings("outline");

/** Examples per gate run, sized so this file takes about 50 seconds inside
 * `proptest/check.sh web`: clean runs measured about 6,400 examples a second
 * there, and about 7,300 with the file run alone. */
export const NUM_RUNS = 319_000;
/** The whole property, shrinking included. Cut off while shrinking, it fails
 * with the smallest counterexample so far; cut off before any failure, it
 * fails as a budget problem, never as a finding. The margin over NUM_RUNS
 * covers a slower gate: run after the other sync files (as on a fresh vitest
 * cache) the file measured about 5,300 examples a second. */
const PROPERTY_LIMIT_MS = 90_000;

type Example = { start: BlockNode[]; commands: Command[] };

/** The start tree one row per line, indented by depth: uid, order_idx, text,
 * heading, view type, and whether it is collapsed. */
function showTree(blocks: readonly BlockNode[]): string {
  const lines: string[] = [];
  const walk = (nodes: readonly BlockNode[], depth: number): void => {
    for (const n of nodes) {
      lines.push(`  ${"  ".repeat(depth)}${n.uid} @${n.order_idx} ${JSON.stringify(n.text)}` +
        ` h=${n.heading ?? "-"} view=${n.view_type ?? "-"}${n.collapsed ? " collapsed" : ""}`);
      walk(n.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return lines.join("\n");
}

/** The failure report: everything needed to read and replay it. */
function report(details: fc.RunDetails<[Example]>): string {
  const counterexample = details.counterexample;
  const shown = counterexample === null ? "none"
    : `start\n${showTree(counterexample[0].start)}\ncommands\n${
      counterexample[0].commands.map((c, i) => `  ${i} ${JSON.stringify(c)}`).join("\n")}`;
  const error = details.errorInstance instanceof Error
    ? details.errorInstance.message : String(details.errorInstance);
  return [
    `outline property failed after ${details.numRuns} runs and ${details.numShrinks} shrinks` +
      (details.interrupted ? " (shrinking cut off at the time limit: the smallest" +
                             " counterexample so far)" : ""),
    `seed: ${details.seed}`,
    `path: ${details.counterexamplePath ?? "none"}`,
    `counterexample: ${shown}`,
    `error: ${error}`,
    `replay: proptest/check.sh web --seed ${details.seed}` +
      (details.counterexamplePath ? ` --path '${details.counterexamplePath}'` : "") +
      " --file outline/outline.prop.ts",
  ].join("\n");
}

test("outline edit commands property", () => {
  const details = fc.check(fc.property(sequenceArb, ({ start, commands }) => {
    const run = runSequence(start, commands);
    const problems = sequenceProblems(start, run);
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }), {
    numRuns: NUM_RUNS, seed: SEED, path: PATH,
    interruptAfterTimeLimit: PROPERTY_LIMIT_MS, markInterruptAsFailure: false,
  });
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
    const text = `outline property ran out of its time budget after ${details.numRuns} of` +
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
