// pattern: Imperative Shell
// The outline edit command property: a random start tree takes a random
// sequence of the real outline commands (run.ts), with undo and redo among
// them, and every step and the whole history are checked (checks.ts). Pure:
// no server, no DOM.
//
// A failure prints the seed, the path, the shrunk start tree and command
// list, every problem the checks found and a replay line.
import { test } from "vitest";
import type { BlockNode } from "../../api/payloads";
import { checkGateProperty } from "../gate";
import { bump, type Tally } from "../reach";
import { sequenceArb, type Command } from "./arbitraries";
import { sequenceProblems } from "./checks";
import { runSequence } from "./run";
import { captureFaultWarnings } from "../warningsCapture";

captureFaultWarnings("outline");

/** Examples per gate run. Sized when clean runs measured about 6,400
 * examples a second inside `proptest/check.sh web` (7,300 run alone), for
 * about 50 seconds there; judging each command with editRefusal since then
 * costs about a fifth of that rate (run alone, 5,900 fell to 4,600), so
 * expect about 65 seconds. */
export const NUM_RUNS = 319_000;
/** The margin over NUM_RUNS covers a slower gate: run after the other sync
 * files (as on a fresh vitest cache) the file measured about 5,300 examples
 * a second, about 4,100 with the judging: 78 seconds. */
const PROPERTY_LIMIT_MS = 90_000;

type Example = { start: BlockNode[]; commands: Command[] };

/** Steps per label: `refused` counts commands the editor refused. */
const tally: Tally = new Map();

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

const show = ([example]: [Example]): string =>
  `counterexample: start\n${showTree(example.start)}\ncommands\n${
    example.commands.map((c, i) => `  ${i} ${JSON.stringify(c)}`).join("\n")}`;

test("outline edit commands property", async () => {
  await checkGateProperty({
    suite: "outline property", file: "outline/outline.prop.ts", arbs: [sequenceArb],
    predicate: async ({ start, commands }: Example) => {
      const run = runSequence(start, commands);
      for (const step of run.steps) if (step.refused !== undefined) bump(tally, "refused");
      const problems = sequenceProblems(start, run);
      if (problems.length > 0) throw new Error(problems.join("\n"));
    },
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, show, tally,
  });
});
