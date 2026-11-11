// pattern: Imperative Shell
// The queue property's teeth: each mutant puts one fixed bug back into the
// queue, and the property must fail on the invariant that exists to catch
// it. A mutant that survives means the property cannot see that bug.
//   resume clears all    the barrier as one boolean: any owner's resume
//                        lifts every claim (barrier, or claim when no POST
//                        follows before the property sees the lost claim)
//   drain past holders   the drain reads the barrier as clear while
//                        holds() still answers truly (barrier alone)
//   mark after the RPC   a batch marked as following the lane only once its
//                        persist reply arrives, so a lost reply leaves its
//                        durable row unmarked (order)
//   claims unreported    a queue whose holds() answers false for every
//                        owner (claim)
//   poison kept          the runtime never resumes poison, so a repair
//                        that succeeds keeps its claim (release)
import { afterEach, beforeEach, vi } from "vitest";
import type { ClientRuntimeDeps } from "../../sync/clientRuntime";
import type { BarrierOwner } from "../../sync/queueState";
import { expectMutantsCaught } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { queueCommands } from "./queueArbitraries";
import { lostReplyIds, type QueueCmd, runQueueExample } from "./queueHarness";

captureFaultWarnings("sync queue teeth");

const mutants = vi.hoisted(() => ({
  resumeClearsAll: false,
  drainIgnoresHolders: false,
  markAfterRpc: false,
  holdsNothing: false,
  keepPoison: false,
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
    terminalReason: (...[state]: Parameters<typeof real.terminalReason>) =>
      real.terminalReason(mutants.drainIgnoresHolders ? { ...state, holders: new Set() } : state),
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

vi.mock("../../sync/opQueue", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../sync/opQueue")>();
  return {
    ...real,
    createOpQueue: (...args: Parameters<typeof real.createOpQueue>) => {
      const queue = real.createOpQueue(...args);
      return { ...queue, holds: (o: BarrierOwner) => !mutants.holdsNothing && queue.holds(o) };
    },
  };
});

vi.mock("../../sync/clientRuntime", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../sync/clientRuntime")>();
  return {
    ...real,
    createClientRuntime: (deps: ClientRuntimeDeps) => real.createClientRuntime({
      ...deps,
      queue: {
        ...deps.queue,
        resume: (o) => { if (!(mutants.keepPoison && o === "poison")) deps.queue.resume(o); },
      },
    }),
  };
});

const NUM_RUNS = 10_000;
const TIME_LIMIT_MS = 15_000;

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); });

const disarm = (): void => {
  mutants.resumeClearsAll = false;
  mutants.drainIgnoresHolders = false;
  mutants.markAfterRpc = false;
  mutants.holdsNothing = false;
  mutants.keepPoison = false;
};

expectMutantsCaught({
  suite: "queue property",
  mutants: {
    "a resume that clears every owner breaks the barrier": {
      catches: ["barrier", "claim"], disarm,
      arm: () => { mutants.resumeClearsAll = true; },
    },
    "a drain that posts past the holders breaks the barrier": {
      catches: ["barrier"], disarm,
      arm: () => { mutants.drainIgnoresHolders = true; },
    },
    "marking a batch only after its persist reply breaks the order": {
      catches: ["order"], disarm,
      arm: () => {
        mutants.markAfterRpc = true;
        mutants.isLost = (id) => [...lostReplyIds].some((lost) => lost === id);
      },
    },
    "a queue that never reports a claim breaks the claim": {
      catches: ["claim"], disarm,
      arm: () => { mutants.holdsNothing = true; },
    },
    "a poison repair that never releases its claim breaks the release": {
      catches: ["release"], disarm,
      arm: () => { mutants.keepPoison = true; },
    },
  },
  arbs: [queueCommands],
  problems: async (_, cmds: QueueCmd[]) => runQueueExample(cmds, () => undefined),
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
});
