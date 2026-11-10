// pattern: Imperative Shell
// The queue property's teeth: each mutant puts one fixed bug back into the
// queue, and the property must fail on the invariant that exists to catch
// it. A mutant that survives means the property cannot see that bug.
//   resume clears all    the barrier as one boolean: any owner's resume
//                        lifts every claim (barrier)
//   mark after the RPC   a batch marked as following the lane only once its
//                        persist reply arrives, so a lost reply leaves its
//                        durable row unmarked (order)
import { afterEach, beforeEach, vi } from "vitest";
import { expectMutantsCaught } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { queueCommands } from "./queueArbitraries";
import { lostReplyIds, type QueueCmd, runQueueExample } from "./queueHarness";

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
const TIME_LIMIT_MS = 15_000;

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); });

const disarm = (): void => {
  mutants.resumeClearsAll = false;
  mutants.markAfterRpc = false;
};

expectMutantsCaught({
  suite: "queue property",
  mutants: {
    "a resume that clears every owner breaks the barrier": {
      catches: ["barrier"], disarm,
      arm: () => { mutants.resumeClearsAll = true; },
    },
    "marking a batch only after its persist reply breaks the order": {
      catches: ["order"], disarm,
      arm: () => {
        mutants.markAfterRpc = true;
        mutants.isLost = (id) => [...lostReplyIds].some((lost) => lost === id);
      },
    },
  },
  arbs: [queueCommands],
  problems: async (_, cmds: QueueCmd[]) => runQueueExample(cmds, () => undefined),
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
});
