// pattern: Imperative Shell
// The assistant panel's chat machine property: drawn action lists (the
// user's actions and every way a request can settle, freely interleaved)
// run through the real reducer against a simulated server, and every step is
// checked against the docs model (run.ts names the invariants). Pure: no
// server, no DOM.
//
// A failure prints the seed, the path, the shrunk action list, the reducer's
// trace of it, the problems and a replay line. The tally of what the
// examples reached is printed after the property.
import { test } from "vitest";
import { checkGateProperty } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { actionsArb, type Action } from "./arbitraries";
import { REAL, runActions, type Tally } from "./run";

captureFaultWarnings("assistant");

/** Examples per gate run, sized so this file takes about 20 seconds inside
 * `proptest/check.sh web`: alone it measured about 65,000 examples a
 * second. */
export const NUM_RUNS = 1_300_000;
const PROPERTY_LIMIT_MS = 60_000;

const tally: Tally = new Map();

const show = ([actions]: [Action[]]): string =>
  `actions:\n${actions.map((a, i) => `  ${i} ${JSON.stringify(a)}`).join("\n")}\n` +
  `trace:\n${runActions(actions).trace.map((t) => `  ${t}`).join("\n")}`;

test("assistant chat machine property", async () => {
  await checkGateProperty({
    suite: "assistant property", file: "assistant/assistant.prop.ts", arbs: [actionsArb],
    predicate: async (actions: Action[]) => {
      const { problems } = runActions(actions, REAL, tally);
      if (problems.length > 0) throw new Error(problems.join("\n"));
    },
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, show, tally,
  });
});
