// pattern: Imperative Shell
// The client/server op divergence property: drawn op batches and outline
// commands run through the harness server, the replica's optimistic apply
// and replay, and the in-memory outline trees, and any difference outside
// the documented exclusions fails (example.ts). Two fixed scenarios run
// first, through the same runner.
//
// A failure prints the seed, the path, the shrunk start state and steps,
// every problem at the first failing step and a replay line. The tally of
// what the examples reached is printed once, after the file.
import fc from "fast-check";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { BatchId, BlockUid, OrderIdx } from "../../api/brands";
import type { BlockNode } from "../../api/payloads";
import { PATH, SEED } from "../sync/env";
import { connectServer, type ServerControl } from "../sync/serverControl";
import { type Example, exampleArb, OPS_PAGES } from "./arbitraries";
import { newTally, runExample, showTally } from "./example";
import { captureFaultWarnings } from "../warningsCapture";

captureFaultWarnings("ops");

/** Examples per gate run, sized so this file takes about 60 seconds inside
 * `proptest/check.sh web`: clean runs measured about 37 examples a second
 * there (each example drives a real server and a replica, plus a fresh one for check R). */
export const NUM_RUNS = 2250;
/** The whole property, shrinking included. Cut off while shrinking, it fails
 * with the smallest counterexample so far; cut off before any failure, it
 * fails as a budget problem, never as a finding. The margin over NUM_RUNS
 * covers a slower gate. */
const PROPERTY_LIMIT_MS = 120_000;

const tally = newTally();
let server: ServerControl;

beforeAll(async () => {
  server = await connectServer();
});

afterAll(() => {
  console.log(showTally(tally));
});

/** A tree one row per line, indented by depth: uid, order_idx, text,
 * heading, view type, and whether it is collapsed. */
function showTree(blocks: readonly BlockNode[]): string {
  const lines: string[] = [];
  const walk = (nodes: readonly BlockNode[], depth: number): void => {
    for (const n of nodes) {
      lines.push(`    ${"  ".repeat(depth)}${n.uid} @${n.order_idx} ${JSON.stringify(n.text)}` +
        ` h=${n.heading ?? "-"} view=${n.view_type ?? "-"}${n.collapsed ? " collapsed" : ""}`);
      walk(n.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return lines.length > 0 ? lines.join("\n") : "    (empty)";
}

function showExample(ex: Example): string {
  const pages = OPS_PAGES.map((p) => `  ${p}\n${showTree(ex.start.pages[p])}`).join("\n");
  const steps = ex.kind === "command"
    ? ex.commands.map((c, i) => `  ${i} ${JSON.stringify(c)}`).join("\n")
    : ex.steps.map((s, i) => [
      `  step ${i + 1}`,
      ...s.batch.map((d) => `    B ${JSON.stringify(d)}`),
      ...(s.other ?? []).map((d) => `    O ${JSON.stringify(d)}`),
    ].join("\n")).join("\n");
  return `${ex.kind} example\nstart\n${pages}\n${ex.kind === "command" ? "commands" : "steps"}\n${steps}`;
}

/** The failure report: everything needed to read and replay it. */
function report(details: fc.RunDetails<[Example]>): string {
  const counterexample = details.counterexample;
  const error = details.errorInstance instanceof Error
    ? details.errorInstance.message : String(details.errorInstance);
  return [
    `ops property failed after ${details.numRuns} runs and ${details.numShrinks} shrinks` +
      (details.interrupted ? " (shrinking cut off at the time limit: the smallest" +
                             " counterexample so far)" : ""),
    `seed: ${details.seed}`,
    `path: ${details.counterexamplePath ?? "none"}`,
    `counterexample: ${counterexample === null ? "none" : showExample(counterexample[0])}`,
    `error: ${error}`,
    `replay: proptest/check.sh web --seed ${details.seed}` +
      (details.counterexamplePath ? ` --path '${details.counterexamplePath}'` : "") +
      " --file ops/ops.prop.ts",
  ].join("\n");
}

const block = (uid: string, order: number, text: string): BlockNode => ({
  uid: uid as BlockUid, text, heading: null, view_type: null, collapsed: false,
  order_idx: order as OrderIdx, created_at: null, updated_at: null, children: [],
});

test("a move onto an open page whose tree lacks the block reloads that page", async () => {
  const t = newTally();
  const ex: Example = {
    start: { pages: { "Outline Props": [], "Ops Two": [block("opsb01", 0, "moved")],
                      "Ops Three": [] } },
    kind: "raw",
    steps: [
      { batch: [{ kind: "move", target: { of: "live", n: 0 }, parent: { to: "top" },
                  page: "Outline Props", slot: { at: "zero" } }], other: null },
      { batch: [{ kind: "update_text", target: { of: "live", n: 0 }, text: "edited",
                  hash: "match" }], other: null },
    ],
  };
  expect(await runExample(server, ex, { tally: t })).toEqual([]);
  expect(t.reloads).toBe(1);
});

test("a batch id reused with other ops is a harness error", async () => {
  const ex: Example = {
    start: { pages: { "Outline Props": [block("opsb01", 0, "one")], "Ops Two": [],
                      "Ops Three": [] } },
    kind: "raw",
    steps: [{ batch: [{ kind: "update_text", target: { of: "live", n: 0 }, text: "two",
                        hash: "none" }], other: null }],
  };
  await expect(runExample(server, ex, { tally: newTally(), batchId: () => "ops-fixed-seed" as BatchId }))
    .rejects.toThrow(/^harness: POST \/api\/ops ops-fixed-seed answered 409/);
});

test("ops property", async () => {
  const details = await fc.check(fc.asyncProperty(exampleArb, async (ex) => {
    const problems = await runExample(server, ex, { tally });
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }), {
    numRuns: NUM_RUNS, seed: SEED, path: PATH,
    interruptAfterTimeLimit: PROPERTY_LIMIT_MS, markInterruptAsFailure: false,
  });
  // A failure keeps failed set when the time limit cuts its shrinking off,
  // with the smallest counterexample so far. Cut off before any failure,
  // fast-check reports interrupted, and failed as well if no example had
  // finished, but with no counterexample: either way that is the budget.
  if (details.failed && details.counterexample !== null) {
    const text = report(details);
    console.error(text);
    throw new Error(text);
  }
  if (details.interrupted) {
    const text = `ops property ran out of its time budget after ${details.numRuns} of` +
      ` ${NUM_RUNS} runs (no failure found): a budget problem, not a finding\n` +
      `seed: ${details.seed}`;
    console.error(text);
    throw new Error(text);
  }
  if (details.failed) {
    const text = report(details);
    console.error(text);
    throw new Error(text);
  }
});
