// pattern: Imperative Shell
// The outline property's teeth: deliberately wrong versions of six outline
// functions, each of which the property must catch: the commands through the
// runner's seam, invertOps and editRefusal through module mocks, since
// planCommand calls them from inside the core. A mutant that survives means
// the property cannot see that bug.
// A catch counts only when it is a property report naming the property the
// mutant breaks: a crash, or a failure of some other property alone, is not
// the property seeing the bug.
//
// Each command mutant wraps the real function and re-derives its tree from the
// mutated ops, so the tree and the ops it reports stay consistent and only the
// meaning is wrong.
import { vi } from "vitest";
import type { BlockOp } from "../../api/ops";
import type { BlockNode } from "../../api/payloads";
import type { EditResult } from "../../outline/edits";
import type * as EditRefusal from "../../outline/editRefusal";
import type * as History from "../../outline/history";
import { applyOps } from "../../outline/tree";
import { expectMutantsCaught } from "../gate";
import { PAGE_TITLE, sequenceArb } from "./arbitraries";
import { sequenceProblems } from "./checks";
import { REAL, runSequence, type Seam } from "./run";
import { captureFaultWarnings } from "../warningsCapture";
import { orderIdxOf } from "../../test-helpers";

type InvertOps = typeof History.invertOps;
type InvertMutant = (real: InvertOps, ...args: Parameters<InvertOps>) => ReturnType<InvertOps>;
type Judge = typeof EditRefusal.editRefusal;
type JudgeMutant = (real: Judge, ...args: Parameters<Judge>) => ReturnType<Judge>;

/** The armed core mutants; null serves the real function. */
interface Swapped { invertOps: InvertMutant | null; editRefusal: JudgeMutant | null }
const swapped = vi.hoisted((): Swapped => ({ invertOps: null, editRefusal: null }));

vi.mock("../../outline/history", async (importOriginal) => {
  const real = await importOriginal<typeof History>();
  return {
    ...real,
    invertOps: (...args: Parameters<InvertOps>) => {
      const wrong = swapped.invertOps;
      return wrong === null ? real.invertOps(...args) : wrong(real.invertOps, ...args);
    },
  };
});

vi.mock("../../outline/editRefusal", async (importOriginal) => {
  const real = await importOriginal<typeof EditRefusal>();
  return {
    ...real,
    editRefusal: (...args: Parameters<Judge>) => {
      const wrong = swapped.editRefusal;
      return wrong === null ? real.editRefusal(...args) : wrong(real.editRefusal, ...args);
    },
  };
});

captureFaultWarnings("outline teeth");

const NUM_RUNS = 3000;
const TIME_LIMIT_MS = 15_000;

interface Mutant {
  seam: Seam;
  /** The properties that see this mutant; a catch must name one of them. */
  catches: readonly string[];
  arm?: () => void;
  disarm?: () => void;
}

/** A mutant of a core function, armed for its own run only: the mocks
 * serve the whole file. */
function inCore<K extends keyof typeof swapped>(
  name: K, wrong: NonNullable<(typeof swapped)[K]>, catches: readonly string[],
): Mutant {
  return {
    seam: REAL, catches,
    arm: () => { swapped[name] = wrong; },
    disarm: () => { swapped[name] = null; },
  };
}

const MEANING = ["meaning"];
const HISTORY = ["undo-stack", "undo-all", "redo-all"];

/** The real result with `ops` swapped for `mutate(ops)`, its tree
 * re-derived. */
function mutated(before: BlockNode[], result: EditResult,
                 mutate: (ops: BlockOp[]) => BlockOp[]): EditResult {
  const ops = mutate(result.ops);
  return { ...result, ops, blocks: applyOps(before, ops, PAGE_TITLE) };
}

const MUTANTS: Record<string, Mutant> = {
  "outdentBlock drops its adopt moves": {
    catches: MEANING,
    seam: {
      ...REAL,
      outdentBlock: (blocks, pageTitle, uid) =>
        mutated(blocks, REAL.outdentBlock(blocks, pageTitle, uid), (ops) => ops.slice(0, 1)),
    },
  },
  "moveBlockDown lands one key further on": {
    catches: MEANING,
    seam: {
      ...REAL,
      moveBlockDown: (blocks, pageTitle, uid) =>
        mutated(blocks, REAL.moveBlockDown(blocks, pageTitle, uid), (ops) =>
          ops.map((op) => op.op === "move" ? { ...op, order_idx: orderIdxOf(op.order_idx + 1) } : op)),
    },
  },
  "planOutlinePaste omits the target's new children": {
    catches: MEANING,
    seam: {
      ...REAL,
      planOutlinePaste: (blocks, pageTitle, uid, from, to, text, newUid) =>
        mutated(blocks, REAL.planOutlinePaste(blocks, pageTitle, uid, from, to, text, newUid),
                (ops) => ops.filter((op) => !(op.op === "create" && op.parent_uid === uid))),
    },
  },
  // Replay re-keys placements by anchor, but the anchors are read off the
  // inverse as recorded, so a wrong key records a wrong anchor and stays wrong.
  "invertOps restores a move with the forward key": inCore(
    "invertOps", (real, blocks, pageTitle, ops) => {
      const inverse = real(blocks, pageTitle, ops);
      if (inverse === null) return null;
      return inverse.map((op) => {
        if (op.op !== "move") return op;
        const forward = ops.find((f) => f.op === "move" && f.uid === op.uid);
        return forward?.op === "move" ? { ...op, order_idx: forward.order_idx } : op;
      });
    }, HISTORY),
  // Only batches holding a move: an undo or redo replays a recorded batch,
  // and none holding a move is ever recorded under this mutant.
  "editRefusal refuses every move": inCore(
    "editRefusal", (real, treeAfter, ops, alsoShipping) =>
      ops.some((op) => op.op === "move") ? "refused by the mutant"
        : real(treeAfter, ops, alsoShipping),
    ["refusal"]),
  "deleteSelection deletes only the first root": {
    catches: MEANING,
    seam: {
      ...REAL,
      deleteSelection: (blocks, pageTitle, uids) =>
        mutated(blocks, REAL.deleteSelection(blocks, pageTitle, uids), (ops) => ops.slice(0, 1)),
    },
  },
};

expectMutantsCaught({
  suite: "outline property", mutants: MUTANTS, arbs: [sequenceArb],
  problems: async (mutant, { start, commands }) =>
    sequenceProblems(start, runSequence(start, commands, mutant.seam)),
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
});
