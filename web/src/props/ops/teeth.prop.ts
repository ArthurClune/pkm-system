// pattern: Imperative Shell
// The ops property's teeth: deliberately wrong versions of the echo apply,
// the optimistic enqueue and the window replay, swapped in through the
// runner's seam (and the harness server's echo fault), each of which the
// property must catch. A catch counts only when the problems include the
// check the mutant breaks: a `harness:` error, or another check failing
// alone, is not the property seeing the bug.
import fc from "fast-check";
import { expect, test } from "vitest";
import type { BlockUid, OrderIdx } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import type { BlockNode } from "../../api/payloads";
import { cloneTree, locate, applyOpsWithChange } from "../../outline/tree";
import { applyChanges } from "../../replica/apply";
import { rollbackToSavepoint } from "../../replica/db";
import { applyLocalOps } from "../../replica/localOps";
import { allBatches, enqueueBatch } from "../../replica/queue";
import { SEED } from "../sync/env";
import { connectServer } from "../sync/serverControl";
import { exampleArb } from "./arbitraries";
import { REAL_OPS, type OpsSeam, runExample } from "./example";
import { captureFaultWarnings } from "../warningsCapture";

captureFaultWarnings("ops teeth");

const NUM_RUNS = 400;
const TIME_LIMIT_MS = 20_000;
const CLEAN_RUNS = 100;
const CLEAN_LIMIT_MS = 120_000;

/** The move branch of the real apply, except that the block lands first and
 * the shift then takes it along with its new siblings. */
function applyEchoShiftingMoved(tree: BlockNode[], ops: BlockOp[], title: string): BlockNode[] {
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
      if (s.order_idx >= op.order_idx) s.order_idx = (s.order_idx + 1) as OrderIdx;
    }
    target.sort((a, b) => a.order_idx - b.order_idx);
  }
  return out;
}

const moveUids = (ops: BlockOp[]): BlockUid[] =>
  ops.flatMap((op) => op.op === "move" ? [op.uid] : []);

interface Mutant {
  seam: OpsSeam;
  /** The check whose prefix a catch must carry. */
  check: string;
  afterSeed?: () => Promise<void>;
}

const MUTANTS: Record<string, Mutant> = {
  "the echo shifts the moved block too": {
    check: "check 1:",
    seam: { ...REAL_OPS, applyEcho: applyEchoShiftingMoved },
  },
  "the optimistic move lands one slot late": {
    check: "check 3:",
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
    check: "check R:",
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
};

const server = await connectServer();

/** The property's own failure text for `ex`, one problem per line. */
class PropertyReport extends Error {}

function property(seam: OpsSeam, afterSeed?: () => Promise<void>) {
  return fc.asyncProperty(exampleArb, async (ex) => {
    const problems = await runExample(server, ex, { seam, afterSeed });
    if (problems.length > 0) throw new PropertyReport(problems.join("\n"));
  });
}

async function expectCaught(name: string, check: string, seam: OpsSeam,
                            afterSeed?: () => Promise<void>): Promise<void> {
  const details = await fc.check(property(seam, afterSeed), {
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
  expect(lines.some((line) => line.includes(check)),
         `mutant caught, but not by ${check} (seed ${details.seed}): ${name}:\n` +
         lines.join("\n")).toBe(true);
  console.log(`teeth: ${name}: caught by ${check} after ${details.numRuns} runs`);
}

for (const [name, { seam, check, afterSeed }] of Object.entries(MUTANTS)) {
  test(`the ops property catches: ${name}`, () => expectCaught(name, check, seam, afterSeed),
       TIME_LIMIT_MS + 30_000);
}

test("the ops property catches: the echo drops a cross-page title", async () => {
  try {
    await expectCaught("the echo drops a cross-page title", "check 1:", REAL_OPS,
                       () => server.setEchoTeeth(true));
  } finally {
    await server.setEchoTeeth(false);
  }
}, TIME_LIMIT_MS + 30_000);

test("the real operations pass the same run", async () => {
  const details = await fc.check(property(REAL_OPS), {
    numRuns: CLEAN_RUNS, seed: SEED, interruptAfterTimeLimit: CLEAN_LIMIT_MS,
    markInterruptAsFailure: true,
  });
  expect(details.failed, String((details.errorInstance as Error | null)?.message)).toBe(false);
}, CLEAN_LIMIT_MS + 30_000);
