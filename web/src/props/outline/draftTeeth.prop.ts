// @vitest-environment jsdom
// pattern: Imperative Shell
// The draft property's teeth: the textarea keeps its own record of being
// dirty, as it once did, set by an edit and cleared only when the tree
// catches up with the edit, by an undo, or by a blur. The pending draft
// can end without the tree catching up (a flush-and-splice command, or a
// flush that sends nothing while a remote edit landed), and then the
// textarea keeps showing stale text. The property must name that `adopt`.
import fc from "fast-check";
import { expect, test } from "vitest";
import type { OutlineHandlers } from "../../outline/handlers";
import { SEED } from "../env";
import { captureFaultWarnings } from "../warningsCapture";
import { runDraftExample, type DraftSeam } from "./draftHarness";
import { draftExampleArb } from "./draftModel";

captureFaultWarnings("outline draft teeth");

const NUM_RUNS = 400;
const TIME_LIMIT_MS = 15_000;

class PropertyReport extends Error {}

function ownDirtyFlag(): DraftSeam {
  // the textarea's last edit while it counts itself dirty
  let dirty: string | null = null;
  return {
    wrapHandlers: (h: OutlineHandlers, treeText: () => string) => ({
      ...h,
      onDraftChange: (uid, text, holdFlush) => {
        dirty = text;
        h.onDraftChange(uid, text, holdFlush);
      },
      pendingDraft: (uid) => {
        const real = h.pendingDraft(uid);
        if (real !== null) return real;
        if (dirty !== null && treeText() !== dirty) {
          return { text: dirty, selection: null };
        }
        dirty = null;
        return null;
      },
      onUndo: () => {
        const undone = h.onUndo();
        if (undone) dirty = null;
        return undone;
      },
      onBlurBlock: (uid) => {
        dirty = null;
        h.onBlurBlock(uid);
      },
      subscribeDraftEnd: () => () => {},
    }),
  };
}

test("the draft property catches a textarea that keeps its own dirty flag",
     async () => {
  const details = await fc.check(fc.asyncProperty(draftExampleArb,
    async (example) => {
      const run = await runDraftExample(example, ownDirtyFlag());
      if (run.problems.length > 0) {
        throw new PropertyReport(run.problems.join("\n"));
      }
    }), {
    numRuns: NUM_RUNS, seed: SEED, endOnFailure: true,
    interruptAfterTimeLimit: TIME_LIMIT_MS,
  });
  const cutOff = details.interrupted
    ? ` (cut off by the ${TIME_LIMIT_MS / 1000}s time limit)` : "";
  expect(details.failed, `mutant survived ${details.numRuns} runs${cutOff}` +
    ` (seed ${details.seed})`).toBe(true);
  const error = details.errorInstance;
  expect(error instanceof PropertyReport, `mutant caught by a thrown error,` +
    ` not a property report (seed ${details.seed}): ${String(error)}`).toBe(true);
  const lines = (error as PropertyReport).message.split("\n");
  expect(lines.some((line) => line.includes("}: adopt: ")),
         `mutant caught, but not by adopt (seed ${details.seed}):\n` +
         lines.join("\n")).toBe(true);
});
