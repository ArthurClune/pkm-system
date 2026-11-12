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
//   discard frees        a discard releases poison even while a repair
//                        runs (claim, or barrier when a POST follows)
//   discard keeps        a discard with no repair running keeps the claim
//                        (release)
//   mark failure frees   a failed mark releases poison, though its row is
//                        still unmarked (claim, barrier)
//   unmatched keeps      a marking round that matched no row keeps the
//                        claim (release)
//   lane ahead skipped   a leased flush posts its batch before the lane
//                        entries it follows (order)
//   leased not terminal  a leased flush reads a rejection as a failure to
//                        retry: its batch claims no poison and a lane entry
//                        ahead stays (claim, or barrier when the rejection
//                        lands while the run quiesces, where no claim is
//                        checked, and a drain then posts)
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
  discardFrees: false,
  discardKeeps: false,
  markFailureFrees: false,
  unmatchedKeeps: false,
  skipLaneAhead: false,
  leasedNotTerminal: false,
  inLeased: false,
  /** Errors from POSTs a leased flush made, so the mutant spares a drain
   * POST that was in flight when the flush began. */
  leasedErrors: new WeakSet<object>(),
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
    headPrecedes: (...args: Parameters<typeof real.headPrecedes>) =>
      !(mutants.skipLaneAhead && mutants.inLeased) && real.headPrecedes(...args),
  };
});

vi.mock("../../sync/rejection", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../sync/rejection")>();
  return {
    ...real,
    isTerminalRejection: (error: unknown): boolean =>
      !(mutants.leasedNotTerminal && error instanceof Error && mutants.leasedErrors.has(error)) &&
      real.isTerminalRejection(error),
  };
});

vi.mock("../../sync/opQueue", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../sync/opQueue")>();
  return {
    ...real,
    createOpQueue: (...[replica, deps]: Parameters<typeof real.createOpQueue>) => {
      const post = deps?.post;
      const queue = real.createOpQueue(replica, post === undefined ? deps : {
        ...deps,
        post: (body) => {
          const sent = post(body);
          if (!mutants.inLeased) return sent;
          return sent.catch((error: unknown) => {
            if (error instanceof Error) mutants.leasedErrors.add(error);
            throw error;
          });
        },
      });
      return {
        ...queue,
        holds: (o: BarrierOwner) => !mutants.holdsNothing && queue.holds(o),
        deliverLeased: async (...[batch, beforePost]: Parameters<typeof queue.deliverLeased>) => {
          mutants.inLeased = true;
          try {
            return await queue.deliverLeased(batch, beforePost);
          } finally {
            mutants.inLeased = false;
          }
        },
      };
    },
  };
});

vi.mock("../../sync/clientRuntime", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../sync/clientRuntime")>();
  return {
    ...real,
    createClientRuntime: (deps: ClientRuntimeDeps) => {
      const runtime = real.createClientRuntime({
        ...deps,
        queue: {
          ...deps.queue,
          resume: (o) => { if (!(mutants.keepPoison && o === "poison")) deps.queue.resume(o); },
          onPoisonMarkFailed: (fn) => deps.queue.onPoisonMarkFailed((failure) => {
            fn(failure);
            if (mutants.markFailureFrees) deps.queue.resume("poison");
          }),
          onPoisonMarkUnmatched: (fn) => deps.queue.onPoisonMarkUnmatched(() => {
            if (!mutants.unmatchedKeeps) fn();
          }),
        },
      });
      return {
        ...runtime,
        discardPoisonIntents: () => {
          if (mutants.discardKeeps) {
            deps.queue.discardPoisonIntents();
            return Promise.resolve();
          }
          const done = runtime.discardPoisonIntents();
          if (mutants.discardFrees) deps.queue.resume("poison");
          return done;
        },
      };
    },
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
  mutants.discardFrees = false;
  mutants.discardKeeps = false;
  mutants.markFailureFrees = false;
  mutants.unmatchedKeeps = false;
  mutants.skipLaneAhead = false;
  mutants.leasedNotTerminal = false;
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
    "a discard that frees poison under a running repair breaks the claim": {
      catches: ["claim", "barrier"], disarm,
      arm: () => { mutants.discardFrees = true; },
    },
    "a discard that keeps poison with no repair running breaks the release": {
      catches: ["release"], disarm,
      arm: () => { mutants.discardKeeps = true; },
    },
    "a failed mark that frees poison breaks the claim": {
      catches: ["claim", "barrier"], disarm,
      arm: () => { mutants.markFailureFrees = true; },
    },
    "an unmatched round that keeps poison breaks the release": {
      catches: ["release"], disarm,
      arm: () => { mutants.unmatchedKeeps = true; },
    },
    "a leased flush that skips the lane ahead breaks the order": {
      catches: ["order"], disarm,
      arm: () => { mutants.skipLaneAhead = true; },
    },
    "a leased flush that ignores a rejection breaks the claim": {
      catches: ["claim", "barrier"], disarm,
      arm: () => { mutants.leasedNotTerminal = true; },
    },
  },
  arbs: [queueCommands],
  problems: async (_, cmds: QueueCmd[]) => runQueueExample(cmds, () => undefined),
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
});
