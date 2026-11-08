// pattern: Imperative Shell
// The queue property: the op queue's recovery barrier and its lane ordering,
// driven one command at a time through queueHarness.ts and judged by
// queueModel.ts. No server: the stand-ins answer, so thousands of
// interleavings run in seconds. The alphabet splits every rule another actor
// can land inside: a POST and its answer, a repair and its success, a legacy
// read and its stable point, a lost enqueue reply and the write behind a
// held gate.
//
// The tally after the file prints how often each command ran or was skipped
// by its precondition, and how often each named interleaving was reached.
import fc from "fast-check";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";
import { PATH, SEED } from "../env";
import { captureFaultWarnings } from "../warningsCapture";
import { queueCommands, QueueReport } from "./queueArbitraries";
import { runQueueExample, showCmd } from "./queueHarness";

captureFaultWarnings("sync queue");

const NUM_RUNS = 10_000;

const tally = new Map<string, number>();
const count = (key: string): void => { tally.set(key, (tally.get(key) ?? 0) + 1); };

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); });

afterAll(() => {
  const width = Math.max(0, ...[...tally.keys()].map((k) => k.length));
  console.log(`sync queue property tally (every run, shrinks included):\n${
    [...tally].sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `  ${k.padEnd(width)}  ${n}`).join("\n")}`);
});

test("the barrier holds for every owner, and the lane keeps enqueue order", async () => {
  await fc.assert(fc.asyncProperty(queueCommands, async (cmds) => {
    const transcript: string[] = [];
    const findings = await runQueueExample(cmds, count, transcript);
    if (findings.length > 0) {
      throw new QueueReport(`${findings.join("\n")}\nran: ${transcript.join("; ")}\n` +
        `drawn: ${cmds.map(showCmd).join("; ")}`);
    }
  }), {
    numRuns: NUM_RUNS,
    ...(SEED === undefined ? {} : { seed: SEED }),
    ...(PATH === undefined ? {} : { path: PATH }),
  });
});
