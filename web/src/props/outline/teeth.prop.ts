// pattern: Imperative Shell
// The outline property's teeth: deliberately wrong versions of five outline
// functions, swapped in through the runner's seam, each of which the property
// must catch. A mutant that survives means the property cannot see that bug.
// A catch counts only when it is a property report naming the property the
// mutant breaks: a crash, or a failure of some other property alone, is not
// the property seeing the bug.
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

/** What the property throws: one problem per line, each led by its property. */
class PropertyReport extends Error {}

interface Mutant {
  seam: Seam;
  /** The properties that see this mutant; a catch must name one of them. */
  catches: readonly string[];
}

const MEANING = ["meaning"];
const HISTORY = ["undo-stack", "undo-all", "redo-all"];

/** The real result with `ops` swapped for `mutate(ops)`, its tree re-derived. */
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
          ops.map((op) => op.op === "move" ? { ...op, order_idx: (op.order_idx + 1) as OrderIdx } : op)),
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
  "invertOps restores a move with the forward key": {
    catches: HISTORY,
    seam: {
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
  },
  "deleteSelection deletes only the first root": {
    catches: MEANING,
    seam: {
      ...REAL,
      deleteSelection: (blocks, pageTitle, uids) =>
        mutated(blocks, REAL.deleteSelection(blocks, pageTitle, uids), (ops) => ops.slice(0, 1)),
    },
  },
};

for (const [name, { seam, catches }] of Object.entries(MUTANTS)) {
  test(`the outline property catches: ${name}`, () => {
    const details = fc.check(fc.property(sequenceArb, ({ start, commands }) => {
      const problems = sequenceProblems(start, runSequence(start, commands, seam));
      if (problems.length > 0) throw new PropertyReport(problems.join("\n"));
    }), {
      numRuns: NUM_RUNS, seed: SEED, endOnFailure: true,
      interruptAfterTimeLimit: TIME_LIMIT_MS,
    });
    const cutOff = details.interrupted
      ? ` (cut off by the ${TIME_LIMIT_MS / 1000}s time limit, not a full run)` : "";
    expect(details.failed, `mutant survived ${details.numRuns} runs${cutOff}` +
      ` (seed ${details.seed}): ${name}`).toBe(true);
    const error = details.errorInstance;
    expect(error instanceof PropertyReport, `mutant caught by a thrown error, not a property` +
      ` report (seed ${details.seed}): ${name}: ${String(error)}`).toBe(true);
    const lines = (error as PropertyReport).message.split("\n");
    expect(lines.some((line) => catches.some((p) => line.startsWith(`${p}: `))),
           `mutant caught, but not by ${catches.join(" or ")} (seed ${details.seed}):` +
           ` ${name}:\n${lines.join("\n")}`).toBe(true);
  });
}
