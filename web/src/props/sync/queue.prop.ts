// pattern: Imperative Shell
// The queue property: the op queue's recovery barrier and its lane ordering,
// driven one command at a time through queueHarness.ts and judged by
// queueModel.ts. No server: the stand-ins answer, so thousands of
// interleavings run in seconds. The alphabet splits every rule another actor
// can land inside: a POST and its answer, a repair and its success, a legacy
// read and its stable point, a lost enqueue reply and the write behind a
// held gate.
//
// The tally after the property prints how often each command ran or was
// skipped by its precondition, and how often each named interleaving was
// reached.
import { afterEach, beforeEach, test, vi } from "vitest";
import { checkGateProperty } from "../gate";
import { bump, type Tally } from "../reach";
import { captureFaultWarnings } from "../warningsCapture";
import { queueCommands, QueueReport } from "./queueArbitraries";
import { type QueueCmd, runQueueExample, showCmd } from "./queueHarness";

captureFaultWarnings("sync queue");

const NUM_RUNS = 10_000;
const PROPERTY_LIMIT_MS = 60_000;

const tally: Tally = new Map();

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
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, tally,
    show: ([cmds]) => `counterexample: ${cmds.map(showCmd).join("; ")}`,
  });
});
