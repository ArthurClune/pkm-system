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
import { checkGateProperty, EXAMPLES } from "../gate";
import type { Reach } from "../reach";
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
/** Where each label must stay above its share of EXAMPLES. */
const REACH: Reach = {
  per: EXAMPLES,
  // Floors: half the lowest share over 30 unseeded gate runs, 2026-11-10.
  // No floor, half the lowest share rounds to 0:
  //   "abort lands after stop while re-creating"
  //   "confirm 404 after stop"
  //   "confirm 404 after stop while re-creating"
  //   "confirm fails after stop"
  //   "confirm fails after stop while re-creating"
  //   "confirm fails for a finished or superseded turn"
  //   "confirm posts after stop"
  //   "confirm posts after stop while re-creating"
  //   "error ends a stopped turn after stop while re-creating"
  //   "harness lost after stop while re-creating"
  //   "stop's fallback aborts after stop while re-creating"
  //   "stream fails after stop while re-creating"
  // No floor yet, not measured; until then what guards each one's reach:
  //   "answer changed after a failure": the teeth "a failed answer can be
  //     changed", which only a run reaching it catches
  //   "answer repeated after a failure": the teeth "a Retry after a failure
  //     posts nothing", likewise
  //   "answer while posting": nothing pins its reach; the at-most-once
  //     `confirm` rule checks the runs that reach it
  floors: {
    "abort lands after stop": 0.012,
    "abort lands for a finished or superseded turn": 0.051,
    "confirm 404": 0.001,
    "confirm 404 for a finished or superseded turn": 0.002,
    "confirm fails": 0.001,
    "confirm posts": 0.004,
    "confirm posts for a finished or superseded turn": 0.001,
    "create fails": 0.098,
    "create fails after stop": 0.018,
    "create fails after stop while re-creating": 0.002,
    "create fails for a finished or superseded turn": 0.008,
    "create resolves": 0.39,
    "create resolves after a default landed meanwhile": 0.027,
    "create resolves after stop": 0.074,
    "create resolves after stop while re-creating": 0.008,
    "create resolves for a finished or superseded turn": 0.035,
    "error ends a stopped turn after stop": 0.01,
    "harness lost": 0.073,
    "harness lost after stop": 0.011,
    "models load with conversation creating": 0.05,
    "models load with conversation none": 0.168,
    "models load with conversation open": 0.138,
    "new chat with conversation creating": 0.05,
    "new chat with conversation none": 0.168,
    "new chat with conversation open": 0.139,
    "pick with conversation creating": 0.05,
    "pick with conversation none": 0.168,
    "pick with conversation open": 0.139,
    "send after a lost harness": 0.038,
    "send after a reap": 0.023,
    "send while busy (creating)": 0.254,
    "send while busy (streaming)": 0.4,
    "skipped answer": 1.404,
    "skipped reap": 0.316,
    "skipped server": 2.584,
    "stop POST settles before its stream is over after stop": 0.06,
    "stop POST settles before its stream is over after stop while re-creating": 0.004,
    "stop POST settles late after stop": 0.053,
    "stop POST settles late after stop while re-creating": 0.003,
    "stop POST settles late for a finished or superseded turn": 0.013,
    "stop while creating": 0.112,
    "stop while re-creating": 0.013,
    "stop while streaming": 0.17,
    "stop's fallback aborts after stop": 0.012,
    "stream 404": 0.059,
    "stream 404 after a lost harness": 0.025,
    "stream 404 after stop": 0.002,
    "stream 404 after stop after a lost harness": 0.004,
    "stream ends": 0.133,
    "stream ends after stop": 0.036,
    "stream ends after stop while re-creating": 0.002,
    "stream ends for a finished or superseded turn": 0.061,
    "stream event": 0.295,
    "stream event after stop": 0.015,
    "stream event after stop while re-creating": 0.001,
    "stream event for a finished or superseded turn (aborted)": 0.009,
    "stream fails": 0.064,
    "stream fails after stop": 0.008,
    "turn_stopped after stop": 0.038,
    "turn_stopped after stop while re-creating": 0.002,
    "unasked turn_stopped": 0.01,
  },
};

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
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, show, tally, reach: REACH,
  });
});
