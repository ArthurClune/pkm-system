// pattern: Imperative Shell
// The queue property's teeth: each mutant puts one fixed bug back into the
// queue, and the property must fail on the invariant that exists to catch
// it. A mutant that survives means the property cannot see that bug.
//   resume clears all    the barrier as one boolean: any owner's resume
//                        lifts every claim (barrier)
//   mark after the RPC   a batch marked as following the lane only once its
//                        persist reply arrives, so a lost reply leaves its
//                        durable row unmarked (order)
import fc from "fast-check";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SEED } from "../env";
import { captureFaultWarnings } from "../warningsCapture";
import { queueCommands } from "./queueArbitraries";
import { lostReplyIds, runQueueExample } from "./queueHarness";

captureFaultWarnings("sync queue teeth");

const mutants = vi.hoisted(() => ({
  resumeClearsAll: false,
  markAfterRpc: false,
  isLost: (_id: string): boolean => false,
}));

vi.mock("../../sync/queueState", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../sync/queueState")>();
  return {
    ...real,
    transitionQueue: (...[state, event]: Parameters<typeof real.transitionQueue>) =>
      mutants.resumeClearsAll && event.type === "resume" && state.holders.has(event.owner)
        ? { state: { ...state, holders: new Set() }, effects: [{ type: "kick" }] }
        : real.transitionQueue(state, event),
  };
});

vi.mock("../../sync/outbox", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../sync/outbox")>();
  return {
    ...real,
    markFollows: (...[s, batchId]: Parameters<typeof real.markFollows>) =>
      mutants.markAfterRpc && mutants.isLost(batchId) ? s : real.markFollows(s, batchId),
  };
});

const NUM_RUNS = 10_000;

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => {
  vi.useRealTimers();
  mutants.resumeClearsAll = false;
  mutants.markAfterRpc = false;
});

/** Runs the property under the current mutant; returns the first finding. */
async function firstFinding(): Promise<string | null> {
  const details = await fc.check(fc.asyncProperty(queueCommands, async (cmds) => {
    const findings = await runQueueExample(cmds, () => undefined);
    if (findings.length > 0) throw new Error(findings.join("\n"));
  }), { numRuns: NUM_RUNS, ...(SEED === undefined ? {} : { seed: SEED }) });
  if (!details.failed) return null;
  const error = details.errorInstance;
  return error instanceof Error ? error.message : String(error);
}

test("a resume that clears every owner breaks the barrier", async () => {
  mutants.resumeClearsAll = true;
  const finding = await firstFinding();
  expect(finding, "mutant survived").not.toBeNull();
  expect(finding).toMatch(/^barrier: /m);
});

test("marking a batch only after its persist reply breaks the order", async () => {
  mutants.markAfterRpc = true;
  mutants.isLost = (id) => [...lostReplyIds].some((lost) => lost === id);
  const finding = await firstFinding();
  expect(finding, "mutant survived").not.toBeNull();
  expect(finding).toMatch(/^order: /m);
});
