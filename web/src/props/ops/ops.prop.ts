// pattern: Imperative Shell
// The client/server op divergence property: drawn op batches and outline
// commands run through the harness server, the replica's optimistic apply
// and replay, and the in-memory outline trees, and any difference outside
// the documented exclusions fails (example.ts). Two fixed scenarios run
// first, through the same runner.
//
// A failure prints the seed, the path, the shrunk start state and steps,
// every problem at the first failing step and a replay line. The tally of
// what the examples reached is printed after the property.
import { beforeAll, expect, test } from "vitest";
import type { BlockNode } from "../../api/payloads";
import { checkGateProperty, EXAMPLES } from "../gate";
import { bump, type Reach, type Tally } from "../reach";
import { connectServer, type ServerControl } from "../sync/serverControl";
import { type Example, exampleArb, OPS_PAGES, type RawDraft } from "./arbitraries";
import { clipText, newTally, runExample, tallyLabels } from "./example";
import { captureFaultWarnings } from "../warningsCapture";
import { uidOf, orderIdxOf, batchIdOf } from "../../test-helpers";

captureFaultWarnings("ops");

/** Examples per gate run. Inside `proptest/check.sh web` clean runs now
 * measure about 28 examples a second, so this file takes about 80 seconds
 * (each example drives a real server and a replica, plus a fresh one for
 * check R). */
export const NUM_RUNS = 2250;
/** The margin over NUM_RUNS covers a slower gate. */
const PROPERTY_LIMIT_MS = 120_000;

const tally: Tally = new Map();
/** Where each label must stay above its share of EXAMPLES. */
const REACH: Reach = {
  per: EXAMPLES,
  // Floors: half the lowest share over 30 unseeded gate runs, 2026-11-10.
  // No floor, under five events in some run:
  //   "command batches both sides refused for a guard"
  //   "variations: text at the length cap"
  // No floor, under ten in some run, so half of it is noise:
  //   "rejections: title length"
  floors: {
    "O steps: O rejected": 0.015,
    "O steps: windows": 0.26,
    "examples: command": 0.188,
    "examples: raw": 0.288,
    "op kinds: create": 0.51,
    "op kinds: create_page": 0.116,
    "op kinds: delete": 0.294,
    "op kinds: move": 0.764,
    "op kinds: set_collapsed": 0.139,
    "op kinds: set_heading": 0.134,
    "op kinds: set_view_type": 0.129,
    "op kinds: update_text": 0.456,
    "pages set aside for an authoritative reload": 0.183,
    "rejections: other": 0.014,
    "rejections: text limit": 0.007,
    "rejections: title syntax": 0.004,
    "skipped ops: block_not_found": 0.135,
    "skipped ops: cycle": 0.115,
    "skipped ops: parent_not_found": 0.18,
    "variations: block named twice": 0.224,
    "variations: cross-page create": 0.062,
    "variations: cross-page move": 0.122,
    "variations: cycle": 0.06,
    "variations: forbidden title": 0.006,
    "variations: missing parent": 0.112,
    "variations: stale subtree hash": 0.071,
    "variations: stale text hash": 0.102,
    "variations: text past a limit": 0.007,
  },
};
let server: ServerControl;

beforeAll(async () => {
  server = await connectServer();
});

/** A tree one row per line, indented by depth: uid, order_idx, text,
 * heading, view type, and whether it is collapsed. */
function showTree(blocks: readonly BlockNode[]): string {
  const lines: string[] = [];
  const walk = (nodes: readonly BlockNode[], depth: number): void => {
    for (const n of nodes) {
      lines.push(`    ${"  ".repeat(depth)}${n.uid} @${n.order_idx}` +
        ` ${JSON.stringify(clipText(n.text))}` +
        ` h=${n.heading ?? "-"} view=${n.view_type ?? "-"}${n.collapsed ? " collapsed" : ""}`);
      walk(n.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return lines.length > 0 ? lines.join("\n") : "    (empty)";
}

/** A draft as JSON, its text clipped as example.ts's trace clips it. */
const showDraft = (d: RawDraft): string =>
  JSON.stringify("text" in d ? { ...d, text: clipText(d.text) } : d);

function showExample(ex: Example): string {
  const pages = OPS_PAGES.map((p) => `  ${p}\n${showTree(ex.start.pages[p])}`).join("\n");
  const steps = ex.kind === "command"
    ? ex.commands.map((c, i) => `  ${i} ${JSON.stringify(c)}`).join("\n")
    : ex.steps.map((s, i) => [
      `  step ${i + 1}`,
      ...s.batch.map((d) => `    B ${showDraft(d)}`),
      ...(s.other ?? []).map((d) => `    O ${showDraft(d)}`),
    ].join("\n")).join("\n");
  return `${ex.kind} example\nstart\n${pages}\n${ex.kind === "command" ? "commands" : "steps"}\n${steps}`;
}

const block = (tag: string, order: number, text: string): BlockNode => ({
  uid: uidOf(tag), text, heading: null, view_type: null, collapsed: false,
  order_idx: orderIdxOf(order), created_at: null, updated_at: null, children: [],
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
  await expect(runExample(server, ex, { tally: newTally(), batchIds: () => batchIdOf("ops-fixed-seed") }))
    .rejects.toThrow(/^harness: POST \/api\/ops ops-fixed-seed answered 409/);
});

test("ops property", async () => {
  await checkGateProperty({
    suite: "ops property", file: "ops/ops.prop.ts", arbs: [exampleArb],
    predicate: async (ex) => {
      const reached = newTally();
      const problems = await runExample(server, ex, { tally: reached });
      for (const [label, n] of tallyLabels(reached)) bump(tally, label, n);
      if (problems.length > 0) throw new Error(problems.join("\n"));
    },
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, tally, reach: REACH,
    show: ([ex]) => `counterexample: ${showExample(ex)}`,
  });
});
