// pattern: Imperative Shell
// The startup poison gate and the poison repair, without React. The sync
// session (session.ts) creates one per replica-backed session and folds its
// sync events through the syncState core; the queue property harness wires
// one by hand.
//
// Startup closes the reload window in which later durable work could post
// before a previously rejected optimistic batch is repaired: the barrier's
// "startup" owner holds from startup() until discovery answers. If it found
// poisoned rows, the "poison" owner takes over before "startup" lets go, and
// holds until a repair of them succeeds. Which Retry a click
// means is decided by retryPolicy.ts; runRetry only executes that decision.
import type { Replica } from "../replica/client";
import { ReplicaUnusableError } from "../replica/errors";
import { coalesce } from "./coalesce";
import type { OpQueue, PoisonEvent } from "./opQueue";
import { orderedPoisonEvents } from "./poisonIntents";
import type { ReplicaSync } from "./replicaSync";
import type { RetryPlan } from "./retryPolicy";
import type { SyncEvent } from "./syncState";

export interface ClientRuntimeDeps {
  queue: Pick<OpQueue, "setOnline" | "pause" | "resume" | "retryPoisonMarks" |
    "refreshPending" | "discardPoisonIntents" | "onPoison" | "onPoisonMarkFailed" |
    "onPoisonMarkUnmatched">;
  replica: Pick<Replica, "poisonedBatches" | "deleteBatch">;
  replicaSync: Pick<ReplicaSync, "start" | "rebaseAuthoritative" |
    "noteUnavailable">;
  /** The session passes its fold over transitionSync. */
  onSyncEvent: (event: SyncEvent) => void;
  /** An owner whose teardown lags its unmount: the session passes its
   * liveness, which turns false synchronously at SyncProvider's unmount,
   * while dispose() waits a microtask so a StrictMode effect replay can keep
   * the runtime.
   * Work in that gap is skipped exactly as after dispose(). */
  isMounted?: () => boolean;
}

export type PoisonRetryPlan = Exclude<RetryPlan, { kind: "outline-repair" }>;

export interface ClientRuntime {
  /** The startup effect's body: setOnline(false), pause, retryPoisonMarks,
   * then continueStartup. Resolves with startupRun(). */
  startup(): Promise<void>;
  /** The promise of the current/last startup run, which the session's first
   * connect waits on; resolved before the first startup(). */
  startupRun(): Promise<void>;
  /** Discovery after marking: repair every marked or discovered poison row,
   * or resume delivery when there is none, then start the replica sync. */
  continueStartup(marked: readonly PoisonEvent[]): Promise<void>;
  /** Repair these poison rows. Resolves with whether the repair that served
   * them succeeded: one that started after the call, or one that had not
   * yet begun deleting, which the call widens. With no rows, resolves at
   * once with whether the last repair succeeded. */
  repair(events: readonly PoisonEvent[]): Promise<boolean>;
  /** Execute a planRetry() result for the poison-side plans; "outline-repair"
   * stays with the session's outline repair. */
  runRetry(plan: PoisonRetryPlan): Promise<void>;
  /** A socket reconnect: rerun a repair whose last attempt failed, exactly as
   * the banner's "repair-targets" Retry does; otherwise nothing. A repair
   * still running is awaited first and retried once if it fails. Never while
   * startup discovery is gated, and never after a failed poison mark, whose
   * Retry is the mark rather than a repair. */
  retryFailedRepair(): Promise<void>;
  /** Give up on retained mark intents and release the barrier they held. */
  discardPoisonIntents(): Promise<void>;
  /** Forget the retained repair targets (a dismissed repaired problem). */
  clearRepairTargets(): void;
  /** True until startup discovery has run to a definite answer. */
  discoveringPoison(): boolean;
  /** Unsubscribes the queue's poison signals; afterwards no callback
   * fires, no repair starts, and no queue.resume or replicaSync.start is
   * called. */
  dispose(): void;
}

export function createClientRuntime(deps: ClientRuntimeDeps): ClientRuntime {
  const { queue, replica, replicaSync } = deps;
  let disposed = false;
  const live = (): boolean => !disposed && (deps.isMounted?.() ?? true);
  const emit = (event: SyncEvent): void => {
    if (live()) deps.onSyncEvent(event);
  };
  const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  let startupRunPromise: Promise<void> = Promise.resolve();
  let repairTargets: readonly PoisonEvent[] = [];
  // Set in the step the run reads its targets, so no call joins a run that
  // will not delete its rows.
  let deleting = false;
  let repairSucceeded = false;
  // The last repair attempt failed and nothing has superseded it. A failed
  // snapshot fetch is most often the network going away, and nothing else
  // retries it: without a reconnect retry the recovery barrier would hold
  // every later edit until a click on Retry or a reload.
  let repairFailed = false;
  let discovering = true;

  const runRepair = async (events: readonly PoisonEvent[]): Promise<boolean> => {
    deleting = false;
    // A failed repair's rows are still poisoned, so a later run takes them
    // too: its success releases "poison".
    repairTargets = orderedPoisonEvents(
      repairFailed ? repairTargets : [], events);
    repairSucceeded = false;
    // A run owed past dispose() or an unmount must not start, yet counts as
    // failed: after a StrictMode replay the session lives on, and its
    // connect's retryFailedRepair repairs these rows.
    if (!live()) {
      repairFailed = true;
      return false;
    }
    repairFailed = false;
    // Held already when the rejection came this session; a row found by
    // startup discovery is claimed here.
    queue.pause("poison");
    const event = repairTargets[0];
    emit({ type: "repair-started", event });
    try {
      await replicaSync.rebaseAuthoritative("poison");
      deleting = true;
      const targets = repairTargets;
      for (const poisonEvent of targets) {
        await replica.deleteBatch(poisonEvent.id, poisonEvent.batch_id);
      }
      if (live()) {
        // The queue is the only publisher of the pending count;
        // refreshPending is the door for an outside re-read of the durable
        // table (see opQueue's emitPending).
        void queue.refreshPending();
        emit({ type: "repair-succeeded", event });
      }
      if (live()) queue.resume("poison");
      repairSucceeded = true;
    } catch (error: unknown) {
      repairFailed = true;
      emit({ type: "repair-failed", event, error: messageOf(error) });
    }
    return repairSucceeded;
  };
  const repairOnce = coalesce<readonly PoisonEvent[], boolean>(runRepair, {
    merge: orderedPoisonEvents, joinable: () => !deleting,
  });

  const repair = (events: readonly PoisonEvent[]): Promise<boolean> => {
    if (events.length === 0) return Promise.resolve(repairSucceeded);
    // A joined call's rows reach the running repair through this list; a
    // starting or owed run rebuilds it from its own arguments.
    repairTargets = orderedPoisonEvents(repairTargets, events);
    return repairOnce(events);
  };

  const continueStartup = async (marked: readonly PoisonEvent[]): Promise<void> => {
    let discovered: PoisonEvent[] = [];
    try {
      discovered = await replica.poisonedBatches();
    } catch (error: unknown) {
      if (marked.length === 0) {
        // Discovery reaching the database and failing may simply mean there is
        // no openable database at all — and the worker is the one party that
        // can tell the difference, so it says so in the error's type. Only its
        // own latched open failure ("unusable") is evidence that there is no
        // poison table for this gate to protect; with no replica there are no
        // poison rows, and holding the barrier would strand every accepted edit
        // in the in-memory fallback lane until the tab closes.
        //
        // Anything else — a dead worker, a module chunk 404 after a deploy
        // against a stale index.html, an RPC timeout — is "we could not ask",
        // not "there is nothing to read", so it keeps the gate and its Retry
        // banner rather than delivering past unread poison. Every branch here
        // must resolve to a definite availability state; none may leave
        // downstream unable to tell what happened.
        if (error instanceof ReplicaUnusableError) {
          discovering = false;
          // There is nothing to "mark": the worker has latched the fact, and
          // every later replica call replays it. The mode's report raises
          // the online-only banner.
          if (live()) {
            replicaSync.noteUnavailable(error);
            queue.resume("poison");
            queue.resume("startup");
          }
          return;
        }
        emit({ type: "poison-discovery-failed", error: messageOf(error) });
        return;
      }
      // Returned mark evidence is sufficient to repair those rows safely;
      // never discard it merely because the broader discovery read failed.
    }
    const repairable = orderedPoisonEvents(marked, discovered);
    discovering = false;
    if (repairable.length > 0) {
      // repair() claims "poison" before it returns, so the barrier never
      // lifts between the two owners.
      const run = repair(repairable);
      if (live()) queue.resume("startup");
      // This repair's own result: an owed one may have started since.
      if (!(await run)) return;
    } else {
      emit({ type: "poison-discovery-cleared" });
      // Nothing is poisoned: a reload's retained intents that matched no row
      // left a "poison" claim with nothing to repair.
      if (live()) {
        queue.resume("poison");
        queue.resume("startup");
      }
    }
    if (live()) await replicaSync.start();
  };

  // Every Retry path ends the same way, and the condition is the point: the
  // replica may only resume syncing once a repair actually succeeded — a
  // restart after a failed one would sync past rows still awaiting repair.
  const restartAfterRepair = async (): Promise<void> => {
    if (repairSucceeded && live()) await replicaSync.start();
  };

  const runRetry = (plan: PoisonRetryPlan): Promise<void> => {
    switch (plan.kind) {
      case "retry-poison-marks":
        return (async () => {
          try {
            const marked = await queue.retryPoisonMarks();
            if (plan.continueStartup) {
              await continueStartup(marked);
              return;
            }
          } catch {
            return;
          }
          await repairOnce.idle();
          await restartAfterRepair();
        })();
      case "continue-startup":
        return continueStartup([]);
      case "repair-targets":
        return repair(repairTargets).then(async (ok) => {
          if (ok && live()) await replicaSync.start();
        });
      case "none":
        return Promise.resolve();
    }
  };

  const offs = [
    queue.onPoison((event) => {
      // Startup mark-only retries are followed by one authoritative database
      // discovery so multiple retained intents and pre-existing poison rows
      // enter the same repair. Current-session poison starts repair directly.
      if (!live() || discovering) return;
      void repair([event]);
    }),
    queue.onPoisonMarkFailed(({ event, error }) => {
      if (!live()) return;
      repairTargets = [event];
      repairSucceeded = false;
      repairFailed = false;
      emit({ type: "poison-mark-failed", event, error: messageOf(error) });
    }),
    // A marking round that matched no row leaves no repair to release the
    // claim the rejection took. Under the discard's rule: during discovery
    // continueStartup releases it, and a running repair keeps it.
    queue.onPoisonMarkUnmatched(() => {
      if (live() && !discovering && !repairOnce.running()) {
        queue.resume("poison");
      }
    }),
  ];

  return {
    startup: () => {
      queue.setOnline(false);
      queue.pause("startup");
      startupRunPromise = (async () => {
        let marked: readonly PoisonEvent[];
        try {
          // Reload fallback intents are marked before any database discovery,
          // initialization, or delivery. This path never calls /api/ops.
          marked = await queue.retryPoisonMarks();
        } catch {
          // The typed failure listener owns the visible Retry state; retain
          // the startup gate and recovery barrier until marking succeeds.
          return;
        }
        if (!live()) return;
        await continueStartup(marked);
      })().catch(() => undefined);
      return startupRunPromise;
    },
    startupRun: () => startupRunPromise,
    continueStartup,
    repair,
    runRetry,
    retryFailedRepair: async () => {
      // A connect that arrives mid-repair waits for it: a fetch hung on the
      // connection the socket just replaced fails only after the reconnect,
      // and the next connect may be far off. Repairs start only once
      // discovery has answered, so the flag also keeps this off the startup
      // gate. A retry clears the flag as it starts, so of several connects
      // waiting on one failed attempt only the first retries it.
      await repairOnce.idle();
      if (!live() || !repairFailed) return;
      await runRetry({ kind: "repair-targets" });
    },
    discardPoisonIntents: () => {
      queue.discardPoisonIntents();
      emit({ type: "poison-intents-discarded" });
      // The intents' claim on "poison" goes with them. A repair still
      // running owns that claim too, and releases it when it succeeds: the
      // claim is one set entry, so releasing it now would free the repair's.
      // Mid-session the still-unmarked durable row is then handed out again:
      // the server rejects it again and the flow re-enters
      // rejectDurableBatch, whose per-batch effects are idempotent across
      // repeats (rememberPoisonMark).
      if (live() && !repairOnce.running()) queue.resume("poison");
      if (discovering) {
        // Rejoin the normal startup: discovery runs against the replica,
        // and an unopenable one falls into the online-only fallback.
        return continueStartup([]);
      }
      return Promise.resolve();
    },
    clearRepairTargets: () => { repairTargets = []; },
    discoveringPoison: () => discovering,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      offs.forEach((off) => off());
    },
  };
}
