// pattern: Imperative Shell
// The queue property: the op queue's recovery barrier and its lane ordering,
// driven one command at a time through queueHarness.ts and judged by
// queueModel.ts. No server: the stand-ins answer, so thousands of
// interleavings run in seconds. The alphabet splits every rule another actor
// can land inside: a POST and its answer, a repair and its success, an outline
// read and its stable point, a lost enqueue reply and the write behind a
// held gate, a recovery and each POST of its leased flush, a failed mark and
// the Retry or Discard that answers it.
//
// The tally after the property prints how often each command ran or was
// skipped by its precondition, and how often each named interleaving was
// reached.
import { afterEach, beforeEach, test, vi } from "vitest";
import { checkGateProperty, EXAMPLES } from "../gate";
import { bump, type Reach, type Tally } from "../reach";
import { captureFaultWarnings } from "../warningsCapture";
import { queueCommands, QueueReport } from "./queueArbitraries";
import { type QueueCmd, runQueueExample, showCmd } from "./queueHarness";

captureFaultWarnings("sync queue");

const NUM_RUNS = 10_000;
const PROPERTY_LIMIT_MS = 60_000;

const tally: Tally = new Map();
/** Where each label must stay above its share of EXAMPLES. */
const REACH: Reach = {
  per: EXAMPLES,
  // Floors: half the lowest share over 30 unseeded gate runs, 2026-11-10;
  // for the mark, discard and leased-flush labels, 2026-11-11, to four
  // places where three would round to nothing; for the rejected lane entry
  // ahead of a leased batch, 2026-11-12, once some examples drew from the
  // recovery mix (queueArbitraries.ts). That mix lowered the poison labels'
  // shares; every floor below held in all 30 runs then.
  // "lane rejected after an outline repair's onStable" counts leased lane
  // rejections too since 2026-11-12, a few per ten thousand.
  // No floor, under ten in some run of those 30: the leased lane copy's
  // answers ("respond ... (leased lane)").
  // Never reached: a mark during a repair, so no unmatched round or failed
  // mark meets a running repair here; a repair holds poison, so no
  // rejection, and so no mark, comes while it runs.
  floors: {
    "desync: lane rejection": 0.031,
    "desync: local refusal": 0.345,
    "discard": 0.01,
    "discard of a failed mark, no repair running": 0.0005,
    "discard skipped": 0.231,
    "discard, during a repair": 0.01,
    "drain": 0.274,
    "durable batch rejected": 0.074,
    "durable rejection while a leased flush runs": 0.0007,
    "edit": 1.661,
    "holdGate": 0.222,
    "holdGate skipped": 0.049,
    "lane batch rejected": 0.031,
    "lane rejected after an outline repair's onStable": 0.003,
    "lane released, others held": 0.003,
    "leased batch posted after a rejected lane entry": 0.001,
    "leased POST beside another": 0.003,
    "leased durable batch rejected": 0.001,
    "leased flush failed": 0.005,
    "leased flush preempted before its batch": 0.002,
    "leased flush with a lane entry ahead": 0.001,
    "leased lane batch rejected": 0.001,
    "mark fails, no repair running": 0.003,
    "mark finds no row, no repair running": 0.003,
    "outline repair fails": 0.044,
    "outline stable: lane owed": 0.015,
    "outline stable: nothing owed": 0.117,
    "outline stable: nothing owed, poison repair failed": 0.003,
    "outlineDone": 0.035,
    "outlineDone skipped": 0.238,
    "outlineFails": 0.044,
    "outlineFails skipped": 0.23,
    "outlineStable": 0.137,
    "outlineStable skipped": 0.691,
    "lost reply: an earlier lane entry is waiting": 0.133,
    "lost reply: its row handed out behind a waiting lane entry": 0.013,
    "lost reply: the row persists after the timeout": 0.06,
    "offline": 0.209,
    "offline skipped": 0.06,
    "online": 0.062,
    "online skipped": 0.21,
    "pauseStartup": 0.223,
    "pauseStartup skipped": 0.05,
    "poison left to a repair released by it": 0.001,
    "poison released, others held": 0.003,
    "poison repair fails": 0.02,
    "poison repair succeeds": 0.02,
    "recovery committed leased acks": 0.0008,
    "recovery ended while lane held": 0.002,
    "recovery released, others held": 0.033,
    "recovery started over a lane POST": 0.014,
    "recoveryEnd": 0.104,
    "recoveryEnd skipped": 0.448,
    "recoveryFlush": 0.017,
    "recoveryFlush skipped": 0.476,
    "recoveryStart": 0.224,
    "recoveryStart skipped": 0.052,
    "releaseGate": 0.104,
    "releaseGate skipped": 0.441,
    "repair": 0.041,
    "repair skipped": 0.787,
    "respond": 0.407,
    "respond ack (durable)": 0.091,
    "respond ack (lane)": 0.052,
    "respond ack (leased durable)": 0.003,
    "respond lostAck (durable)": 0.045,
    "respond lostAck (lane)": 0.025,
    "respond lostAck (leased durable)": 0.001,
    "respond netFail (durable)": 0.046,
    "respond netFail (lane)": 0.025,
    "respond netFail (leased durable)": 0.001,
    "respond skipped": 1.818,
    "resumeStartup": 0.105,
    "resumeStartup skipped": 0.449,
    "retryMarks": 0.0007,
    "retryMarks skipped": 0.244,
    "retryTimer": 0.272,
    "startup released, others held": 0.032,
    "unmatched round, no repair": 0.003,
  },
};

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); });

test("the barrier holds for every owner, and the lane keeps enqueue order", async () => {
  await checkGateProperty({
    suite: "sync queue property", file: "sync/queue.prop.ts", arbs: [queueCommands],
    predicate: async (cmds: QueueCmd[]) => {
      const transcript: string[] = [];
      const findings = await runQueueExample(cmds, (key) => bump(tally, key), transcript);
      if (findings.length > 0) {
        throw new QueueReport(`${findings.join("\n")}\nran: ${transcript.join("; ")}\n` +
          `drawn: ${cmds.map(showCmd).join("; ")}`);
      }
    },
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, tally, reach: REACH,
    show: ([cmds]) => `counterexample: ${cmds.map(showCmd).join("; ")}`,
  });
});
