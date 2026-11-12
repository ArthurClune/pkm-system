// pattern: Imperative Shell
// The chat driver property: drawn action lists (the user's actions, each step
// of every request the driver sends, and the clock, freely interleaved) run
// through the real createChatDriver with a fake client, and what it publishes
// and sends is judged against the pure machine and the I/O rules of
// contracts/frontend.md § The chat machine (driverRun.ts names the invariants).
// The driver's timers and Date.now are vitest's fakes, so a run replays from
// its seed.
//
// A failure prints the seed, the path, the shrunk action list, the
// machine's trace of it, the problems and a replay line. The tally of what
// the examples reached is printed after the property.
import { test } from "vitest";
import { checkGateProperty, EXAMPLES } from "../gate";
import type { Reach, Tally } from "../reach";
import { captureFaultWarnings } from "../warningsCapture";
import { driverActionsArb, type DriverAction } from "./driverArbitraries";
import { fakeDriverClock, REAL_DRIVER, runDriverActions } from "./driverRun";

captureFaultWarnings("assistant driver");

/** Examples per gate run, sized so this file takes about 15 seconds alone:
 * it measured about 3,400 examples a second. */
export const NUM_RUNS = 50_000;
const PROPERTY_LIMIT_MS = 60_000;

const tally: Tally = new Map();
/** Where each label must stay above its share of EXAMPLES. */
const REACH: Reach = {
  per: EXAMPLES,
  // Floors: half the lowest share over 30 unseeded gate runs, 2026-11-11,
  // to four places where three would round to nothing.
  // No floor, under ten in some run: a confirm POST that 404s or fails
  // after Stop or during a later turn, and one that posts during a later
  // turn.
  // Never reached by the real driver: "a retry whose back-off was aborted
  // is never sent", as the back-off checks again before it retries.
  floors: {
    "409 after stop": 0.006,
    "409 while streaming": 0.046,
    "a 409 fails the turn": 0.013,
    "a 409 is retried": 0.014,
    "a stream starts while the last one's body is still open": 0.002,
    "abort lands after stop": 0.017,
    "abort lands during a later turn": 0.008,
    "abort lands for an ended turn": 0.064,
    "an aborted stream still delivers an event": 0.017,
    "an old stream's event during a later turn in another chat": 0.001,
    "an old stream's event for an ended turn in another chat": 0.01,
    "answer": 0.005,
    "confirm 404": 0.0001,
    "confirm 404 for an ended turn": 0.0001,
    "confirm fails": 0.0002,
    "confirm fails for an ended turn": 0.0001,
    "confirm posts": 0.001,
    "confirm posts after stop": 0.0001,
    "confirm posts for an ended turn": 0.0006,
    "create fails": 0.088,
    "create fails after stop": 0.015,
    "create fails during a later turn": 0.001,
    "create fails for an ended turn": 0.011,
    "create resolves": 0.353,
    "create resolves after stop": 0.063,
    "create resolves during a later turn": 0.005,
    "create resolves for an ended turn": 0.048,
    "DELETE of a conversation made for a superseded turn": 0.054,
    "DELETE sent once the aborted stream settled": 0.082,
    "DELETE settles": 0.191,
    "fallback aborts the stop POST (the deadline passed)": 0.013,
    "fallback aborts the stream (the deadline passed)": 0.026,
    "fallback aborts the stream (the stop POST failed)": 0.007,
    "new chat while creating": 0.066,
    "new chat while stopping": 0.035,
    "new chat while stopping in a 409's back-off": 0.004,
    "new chat while streaming": 0.075,
    "new chat while streaming in a 409's back-off": 0.009,
    "new chat's DELETE goes at once": 0.091,
    "new chat's DELETE waits for the aborted stream": 0.097,
    "send while busy": 0.387,
    "skipped answer": 1.018,
    "skipped settle": 3.187,
    "skipped tick": 0.961,
    "stop before the stream opens": 0.07,
    "stop during a 409's back-off": 0.014,
    "stop POST answers after stop": 0.025,
    "stop POST answers during a later turn": 0.0004,
    "stop POST answers for an ended turn": 0.003,
    "stop POST fails after stop": 0.01,
    "stop POST fails during a later turn": 0.0001,
    "stop POST fails for an ended turn": 0.001,
    "stop POST settles after its abort after stop": 0.009,
    "stop POST settles after its abort during a later turn": 0.0005,
    "stop POST settles after its abort for an ended turn": 0.002,
    "stop posted at once": 0.042,
    "stop posted once the stream opened": 0.026,
    "stop posts nothing: the stream settled first": 0.044,
    "stop while creating": 0.1,
    "stop while the stream is open": 0.042,
    "stream 404": 0.046,
    "stream 404 after stop": 0.006,
    "stream ends": 0.046,
    "stream ends after stop": 0.011,
    "stream ends after stop (aborted)": 0.003,
    "stream ends during a later turn": 0.0006,
    "stream ends during a later turn (aborted)": 0.001,
    "stream ends for an ended turn": 0.006,
    "stream ends for an ended turn (aborted)": 0.009,
    "stream fails": 0.08,
    "stream fails after stop": 0.013,
    "stream fails during a later turn": 0.0001,
    "stream fails for an ended turn": 0.001,
    "stream opens": 0.179,
    "stream opens after stop": 0.026,
    "the stop's deadline passes with nothing open": 0.005,
    "the stop's deadline passes with the turn still open": 0.034,
    "turn_stopped after a posted stop": 0.012,
    "unasked turn_stopped": 0.004,
    "unasked turn_stopped after a posted stop": 0.0008,
  },
};

fakeDriverClock();

const show = (actions: DriverAction[], trace: string[]): string =>
  `actions:\n${actions.map((a, i) => `  ${i} ${JSON.stringify(a)}`).join("\n")}\n` +
  `trace:\n${trace.map((t) => `  ${t}`).join("\n")}`;

test("assistant chat driver property", async () => {
  // the report body for the last failing example, which is the one
  // shrinking settles on
  let shown = "";
  await checkGateProperty({
    suite: "assistant driver property", file: "assistant/driver.prop.ts", arbs: [driverActionsArb],
    predicate: async (actions: DriverAction[]) => {
      const { problems, trace } = await runDriverActions(actions, REAL_DRIVER, tally);
      if (problems.length > 0) {
        shown = show(actions, trace);
        throw new Error(problems.join("\n"));
      }
    },
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, show: () => shown, tally, reach: REACH,
  });
});
