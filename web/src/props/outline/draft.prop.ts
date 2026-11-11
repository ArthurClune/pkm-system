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
import { checkGateProperty, EXAMPLES } from "../gate";
import { bump, type Reach, type Tally } from "../reach";
import { captureFaultWarnings } from "../warningsCapture";
import { runDraftExample } from "./draftHarness";
import { draftExampleArb, type DraftExample } from "./draftModel";

captureFaultWarnings("outline draft");

/** Examples per gate run, sized so this file takes about 16 seconds: run
 * alone, clean runs measured about 215 examples a second, each rendering the
 * editor afresh. */
export const NUM_RUNS = 3_500;
const PROPERTY_LIMIT_MS = 120_000;

const tally: Tally = new Map();
/** Where each label must stay above its share of EXAMPLES. */
const REACH: Reach = {
  per: EXAMPLES,
  // Floors: half the lowest share over 30 unseeded gate runs, 2026-11-10.
  // No floor, under ten in some run, so half of it is noise:
  //   "Enter-229-late"
  floors: {
    "Enter-229-unowned": 0.037,
    "Enter-right-after-end": 0.002,
    "Escape-229-late": 0.001,
    "Escape-229-unowned": 0.035,
    "Escape-right-after-end": 0.002,
    "compose-end": 0.055,
    "compose-end-adopts": 0.006,
    "conflict": 0.022,
    "debounce-flush": 0.035,
    "enter-splits": 0.064,
    "erase-to-base": 0.011,
    "flush-sends-nothing": 0.014,
    "flush-then-splice": 0.042,
    "ime-Enter-after-end": 0.004,
    "ime-Enter-composing": 0.018,
    "ime-Enter-flagged": 0.021,
    "ime-Escape-after-end": 0.004,
    "ime-Escape-composing": 0.018,
    "ime-Escape-flagged": 0.021,
    "remote-under-draft": 0.046,
    "remote-while-composing": 0.023,
    "replay-under-draft": 0.045,
    "replay-while-composing": 0.024,
    "skip": 0.762,
    "splice-over-unsent-draft": 0.003,
    "typed-over-held-text": 0.014,
    "undo-applied": 0.043,
    "undo-over-draft": 0.035,
    "undo-while-composing": 0.024,
  },
};

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
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, show, tally, reach: REACH,
  });
});
