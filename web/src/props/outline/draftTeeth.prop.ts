// @vitest-environment jsdom
// pattern: Imperative Shell
// The draft property's teeth: the textarea keeps its own record of being
// dirty, as it once did, set by an edit and cleared only when the tree
// catches up with the edit, by an undo, or by a blur. The pending draft
// can end without the tree catching up (a flush-and-splice command, or a
// flush that sends nothing while a remote edit landed), and then the
// textarea keeps showing stale text. The property must name that `adopt`.
import type { OutlineHandlers } from "../../outline/handlers";
import { expectMutantsCaught } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { runDraftExample, type DraftSeam } from "./draftHarness";
import { draftExampleArb, type DraftExample } from "./draftModel";

captureFaultWarnings("outline draft teeth");

const NUM_RUNS = 400;
const TIME_LIMIT_MS = 15_000;

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

expectMutantsCaught({
  suite: "draft property",
  mutants: { "a textarea that keeps its own dirty flag": { catches: ["adopt"] } },
  arbs: [draftExampleArb],
  problems: async (_, example: DraftExample) =>
    (await runDraftExample(example, ownDirtyFlag())).problems,
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
  caughtBy: (line, rule) => line.includes(`}: ${rule}: `),
});
