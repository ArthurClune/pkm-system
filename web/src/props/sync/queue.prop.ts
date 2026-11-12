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
  // Floors: half the lowest share over 30 unseeded gate runs, rounded down
  // to three places, or four where three would round to nothing. Measured
  // 2026-11-10, the mark, discard and leased-flush labels 2026-11-11. On
  // 2026-11-12, once one example in seven drew from the recovery mix
  // (queueArbitraries.ts), 30 runs of it re-derived every floor whose
  // lowest count there fell under twice the floor, and set the floors of
  // the rejected lane entry ahead of a leased batch.
  // "lane rejected after an outline repair's onStable" counts leased lane
  // rejections too since 2026-11-12, a few per ten thousand.
  // No floor, under ten in some run of those 30: the leased lane copy's
  // answers ("respond ... (leased lane)"), and "discard of a failed mark,
  // no repair running" (lowest 7; 11 before the recovery mix).
  // Never reached: a mark during a repair, so no unmatched round or failed
  // mark meets a running repair here; a repair holds poison, so no
  // rejection, and so no mark, comes while it runs.
  floors: {
    "desync: lane rejection": 0.031,
    "desync: local refusal": 0.275,
    "discard": 0.01,
    "discard skipped": 0.229,
    "discard, during a repair": 0.009,
    "drain": 0.245,
    "durable batch rejected": 0.063,
    "durable rejection while a leased flush runs": 0.0007,
    "edit": 1.589,
    "holdGate": 0.198,
    "holdGate skipped": 0.041,
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
    "mark fails, no repair running": 0.002,
    "mark finds no row, no repair running": 0.003,
    "outline repair fails": 0.035,
    "outline stable: lane owed": 0.014,
    "outline stable: nothing owed": 0.091,
    "outline stable: nothing owed, poison repair failed": 0.001,
    "outlineDone": 0.025,
    "outlineDone skipped": 0.213,
    "outlineFails": 0.035,
    "outlineFails skipped": 0.199,
    "outlineStable": 0.109,
    "outlineStable skipped": 0.585,
    "lost reply: an earlier lane entry is waiting": 0.101,
    "lost reply: its row handed out behind a waiting lane entry": 0.01,
    "lost reply: the row persists after the timeout": 0.047,
    "offline": 0.209,
    "offline skipped": 0.06,
    "online": 0.062,
    "online skipped": 0.182,
    "pauseStartup": 0.198,
    "pauseStartup skipped": 0.04,
    "poison left to a repair released by it": 0.001,
    "poison released, others held": 0.001,
    "poison repair fails": 0.012,
    "poison repair succeeds": 0.013,
    "recovery committed leased acks": 0.0008,
    "recovery ended while lane held": 0.001,
    "recovery released, others held": 0.026,
    "recovery started over a lane POST": 0.014,
    "recoveryEnd": 0.084,
    "recoveryEnd skipped": 0.366,
    "recoveryFlush": 0.017,
    "recoveryFlush skipped": 0.476,
    "recoveryStart": 0.224,
    "recoveryStart skipped": 0.052,
    "releaseGate": 0.085,
    "releaseGate skipped": 0.396,
    "repair": 0.027,
    "repair skipped": 0.736,
    "respond": 0.353,
    "respond ack (durable)": 0.073,
    "respond ack (lane)": 0.04,
    "respond ack (leased durable)": 0.003,
    "respond lostAck (durable)": 0.036,
    "respond lostAck (lane)": 0.018,
    "respond lostAck (leased durable)": 0.001,
    "respond netFail (durable)": 0.037,
    "respond netFail (lane)": 0.019,
    "respond netFail (leased durable)": 0.001,
    "respond skipped": 1.534,
    "resumeStartup": 0.084,
    "resumeStartup skipped": 0.4,
    "retryMarks": 0.0006,
    "retryMarks skipped": 0.24,
    "retryTimer": 0.243,
    "startup released, others held": 0.027,
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
