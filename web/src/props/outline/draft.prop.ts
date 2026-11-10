// @vitest-environment jsdom
// pattern: Imperative Shell
// The outline draft property: one block in the real editor (useOutline and
// EditableBlockTree in jsdom) takes a random interleaving of typing, erasing,
// debounce ticks, remote edits, replays landing through an authoritative
// read, a flush-and-splice command, undo, blur, refocus, IME composition
// start and end, and Enter or Escape keydowns in each engine's composition
// shape. After every step the editor must agree with draftModel.ts: the
// outline holds a pending draft exactly when the model does, the textarea
// shows that draft or else the tree's text (or, mid-composition, what it
// showed), every flush hashes the text its draft was typed over, a conflict
// arises only under a remote edit or replay, and a keydown the IME owns sends
// and splits nothing while any other Enter splits.
//
// A failure prints the seed, the path, the shrunk example and a replay line.
import { test } from "vitest";
import { checkGateProperty } from "../gate";
import { bump, type Tally } from "../reach";
import { captureFaultWarnings } from "../warningsCapture";
import { runDraftExample } from "./draftHarness";
import { draftExampleArb, type DraftExample } from "./draftModel";

captureFaultWarnings("outline draft");

/** Examples per gate run, sized so this file takes about 16 seconds: run
 * alone, clean runs measured about 215 examples a second, each rendering the
 * editor afresh. */
export const NUM_RUNS = 3_500;
const PROPERTY_LIMIT_MS = 45_000;

const tally: Tally = new Map();

const show = ([example]: [DraftExample]): string =>
  `counterexample: start ${JSON.stringify(example.start)}\ncommands\n${
    example.commands.map((c, i) => `  ${i} ${JSON.stringify(c)}`).join("\n")}`;

test("outline draft property", async () => {
  await checkGateProperty({
    suite: "outline draft property", file: "outline/draft.prop.ts", arbs: [draftExampleArb],
    predicate: async (example: DraftExample) => {
      const run = await runDraftExample(example);
      for (const label of run.labels) bump(tally, label);
      if (run.problems.length > 0) throw new Error(run.problems.join("\n"));
    },
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, show, tally,
  });
});
