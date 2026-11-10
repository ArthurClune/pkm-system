// pattern: Imperative Shell
// The ops property's teeth: deliberately wrong versions of the echo apply,
// the optimistic enqueue and the window replay, swapped in through the
// runner's seam (and the harness server's echo and text-limit faults), each
// of which the property must catch. A catch counts only when the problems
// include the check the mutant breaks: a `harness:` error, or another check
// failing alone, is not the property seeing the bug.
import fc from "fast-check";
import { expect, test } from "vitest";
import type { BlockUid, RawTitle } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import type { BlockNode } from "../../api/payloads";
import { cloneTree, locate, applyOpsWithChange } from "../../outline/tree";
import { applyChanges } from "../../replica/apply";
import { rollbackToSavepoint } from "../../replica/db";
import { applyLocalOps } from "../../replica/localOps";
import { allBatches, enqueueBatch } from "../../replica/queue";
import { expectMutantsCaught } from "../gate";
import { SEED } from "../sync/env";
import { connectServer } from "../sync/serverControl";
import { type Example, exampleArb } from "./arbitraries";
import { REAL_OPS, type OpsSeam, runExample } from "./example";
import { captureFaultWarnings } from "../warningsCapture";
import { orderIdxOf, uidOf } from "../../test-helpers";

captureFaultWarnings("ops teeth");

const NUM_RUNS = 400;
const TIME_LIMIT_MS = 20_000;
const CLEAN_RUNS = 100;
const CLEAN_LIMIT_MS = 120_000;

/** The move branch of the real apply, except that the block lands first and
 * the shift then takes it along with its new siblings. */
function applyEchoShiftingMoved(tree: BlockNode[], ops: BlockOp[], title: RawTitle): BlockNode[] {
  const out = cloneTree(tree);
  for (const op of ops) {
    const found = op.op === "move" && (op.page_title == null || op.page_title === title)
      ? locate(out, op.uid) : null;
    if (op.op !== "move" || found === null) {
      const applied = applyOpsWithChange(out, [op], title).blocks;
      out.splice(0, out.length, ...applied);
      continue;
    }
    const target = op.parent_uid === null ? out : locate(out, op.parent_uid)?.node.children;
    if (target === undefined) continue;
    found.siblings.splice(found.index, 1);
    found.node.order_idx = op.order_idx;
    target.push(found.node);
    for (const s of target) {
      if (s.order_idx >= op.order_idx) s.order_idx = orderIdxOf(s.order_idx + 1);
    }
    target.sort((a, b) => a.order_idx - b.order_idx);
  }
  return out;
}

const moveUids = (ops: BlockOp[]): BlockUid[] =>
  ops.flatMap((op) => op.op === "move" ? [op.uid] : []);

interface Mutant {
  seam: OpsSeam;
  /** The checks whose prefix a catch must carry. */
  catches: readonly string[];
  afterSeed?: () => Promise<void>;
  disarm?: () => Promise<void>;
}

const server = await connectServer();

const MUTANTS: Record<string, Mutant> = {
  "the echo shifts the moved block too": {
    catches: ["check 1:"],
    seam: { ...REAL_OPS, applyEcho: applyEchoShiftingMoved },
  },
  "the optimistic move lands one slot late": {
    catches: ["check 3:"],
    seam: {
      ...REAL_OPS,
      enqueue: (db, ops, nowMs, batchId) => {
        enqueueBatch(db, ops, nowMs, batchId);
        for (const uid of moveUids(ops)) {
          db.exec("UPDATE blocks SET order_idx = order_idx + 1 WHERE uid = ?", [uid]);
        }
      },
    },
  },
  "the replay is applied without rewinding first": {
    catches: ["check R:"],
    seam: {
      ...REAL_OPS,
      applyWindow: (db, feed, nowMs) => {
        const result = applyChanges(db, feed, nowMs);
        db.transaction(() => {
          for (const b of allBatches(db)) {
            if (b.poisoned) continue;
            for (const op of b.ops) {
              db.exec("SAVEPOINT teeth_op");
              try {
                applyLocalOps(db, [op], nowMs, { batchId: b.batch_id });
              } catch {
                // A throwing op is skipped alone, as the real replay does.
                rollbackToSavepoint(db, "teeth_op");
              }
              db.exec("RELEASE teeth_op");
            }
          }
        });
        return result;
      },
    },
  },
  "the echo drops a cross-page title": {
    catches: ["check 1:"], seam: REAL_OPS,
    afterSeed: () => server.setEchoTeeth(true),
    disarm: () => server.setEchoTeeth(false),
  },
  "the server takes text past the limits": {
    catches: ["rejection:"], seam: REAL_OPS,
    afterSeed: () => server.setLimitTeeth(true),
    disarm: () => server.setLimitTeeth(false),
  },
  "the server refuses text at the limits": {
    catches: ["rejection:"], seam: REAL_OPS,
    afterSeed: () => server.setStrictLimitTeeth(true),
    disarm: () => server.setStrictLimitTeeth(false),
  },
};

expectMutantsCaught({
  suite: "ops property", mutants: MUTANTS, arbs: [exampleArb],
  problems: (mutant, ex) =>
    runExample(server, ex, { seam: mutant.seam, afterSeed: mutant.afterSeed }),
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
  caughtBy: (line, check) => line.includes(check),
});

test("a seed the server refuses at a limit is a rejection, not a harness fault", async () => {
  const at = (n: number, text: string): BlockNode => ({
    uid: uidOf(`opsb${String(n).padStart(2, "0")}`), text, heading: null, view_type: null,
    collapsed: false, order_idx: orderIdxOf(n), created_at: null, updated_at: null,
    children: [],
  });
  const ex: Example = {
    start: { pages: { "Outline Props": [at(0, "a"), at(1, `${"[[a//".repeat(32)}x${"]]".repeat(32)}`)],
                      "Ops Two": [], "Ops Three": [] } },
    kind: "raw",
    steps: [{ batch: [{ kind: "set_collapsed", target: { of: "live", n: 0 }, collapsed: true }],
              other: null }],
  };
  try {
    const problems = await runExample(server, ex, {
      beforeSeed: () => server.setStrictLimitTeeth(true) });
    expect(problems).toEqual([
      "at the seed",
      "rejection: the server refused the seed for its text limit (block opsb01: [[ nested 32" +
        " levels deep is over the limit of 31) but enqueueBatch's judge takes it",
    ]);
  } finally {
    await server.setStrictLimitTeeth(false);
  }
});

test("the real operations pass the same run", async () => {
  const details = await fc.check(fc.asyncProperty(exampleArb, async (ex) => {
    const problems = await runExample(server, ex, { seam: REAL_OPS });
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }), {
    numRuns: CLEAN_RUNS, seed: SEED, interruptAfterTimeLimit: CLEAN_LIMIT_MS,
    markInterruptAsFailure: true,
  });
  expect(details.failed, String((details.errorInstance as Error | null)?.message)).toBe(false);
}, CLEAN_LIMIT_MS + 30_000);
