// pattern: Imperative Shell
// The outline property's teeth: deliberately wrong versions of five outline
// functions, swapped in through the runner's seam, each of which the property
// must catch. A mutant that survives means the property cannot see that bug.
//
// Each command mutant wraps the real function and re-derives its tree from the
// mutated ops, so the tree and the ops it reports stay consistent and only the
// meaning is wrong.
import fc from "fast-check";
import { expect, test } from "vitest";
import type { OrderIdx } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import type { BlockNode } from "../../api/payloads";
import type { EditResult } from "../../outline/edits";
import { applyOps } from "../../outline/tree";
import { SEED } from "../env";
import { PAGE_TITLE, sequenceArb } from "./arbitraries";
import { sequenceProblems } from "./checks";
import { REAL, runSequence, type Seam } from "./run";

const NUM_RUNS = 3000;
const TIME_LIMIT_MS = 15_000;

/** The real result with `ops` swapped for `mutate(ops)`, its tree re-derived. */
function mutated(before: BlockNode[], result: EditResult,
                 mutate: (ops: BlockOp[]) => BlockOp[]): EditResult {
  const ops = mutate(result.ops);
  return { ...result, ops, blocks: applyOps(before, ops, PAGE_TITLE) };
}

const MUTANTS: Record<string, Seam> = {
  "outdentBlock drops its adopt moves": {
    ...REAL,
    outdentBlock: (blocks, pageTitle, uid) =>
      mutated(blocks, REAL.outdentBlock(blocks, pageTitle, uid), (ops) => ops.slice(0, 1)),
  },
  "moveBlockDown lands one key further on": {
    ...REAL,
    moveBlockDown: (blocks, pageTitle, uid) =>
      mutated(blocks, REAL.moveBlockDown(blocks, pageTitle, uid), (ops) =>
        ops.map((op) => op.op === "move" ? { ...op, order_idx: (op.order_idx + 1) as OrderIdx } : op)),
  },
  "planOutlinePaste omits the target's new children": {
    ...REAL,
    planOutlinePaste: (blocks, pageTitle, uid, from, to, text, newUid) =>
      mutated(blocks, REAL.planOutlinePaste(blocks, pageTitle, uid, from, to, text, newUid),
              (ops) => ops.filter((op) => !(op.op === "create" && op.parent_uid === uid))),
  },
  // Replay re-keys placements by anchor, but the anchors are read off the
  // inverse as recorded, so a wrong key records a wrong anchor and stays wrong.
  "invertOps restores a move with the forward key": {
    ...REAL,
    invertOps: (blocks, pageTitle, ops) => {
      const inverse = REAL.invertOps(blocks, pageTitle, ops);
      if (inverse === null) return null;
      return inverse.map((op) => {
        if (op.op !== "move") return op;
        const forward = ops.find((f) => f.op === "move" && f.uid === op.uid);
        return forward?.op === "move" ? { ...op, order_idx: forward.order_idx } : op;
      });
    },
  },
  "deleteSelection deletes only the first root": {
    ...REAL,
    deleteSelection: (blocks, pageTitle, uids) =>
      mutated(blocks, REAL.deleteSelection(blocks, pageTitle, uids), (ops) => ops.slice(0, 1)),
  },
};

for (const [name, seam] of Object.entries(MUTANTS)) {
  test(`the outline property catches: ${name}`, () => {
    const details = fc.check(fc.property(sequenceArb, ({ start, commands }) => {
      const problems = sequenceProblems(start, runSequence(start, commands, seam));
      if (problems.length > 0) throw new Error(problems.join("\n"));
    }), {
      numRuns: NUM_RUNS, seed: SEED, endOnFailure: true,
      interruptAfterTimeLimit: TIME_LIMIT_MS,
    });
    console.log(`${name}: ${details.failed ? "caught" : "survived"} after ${details.numRuns}` +
      ` runs and ${details.numShrinks} shrinks`);
    expect(details.failed, `mutant survived ${details.numRuns} runs` +
      ` (seed ${details.seed}): ${name}`).toBe(true);
  });
}
