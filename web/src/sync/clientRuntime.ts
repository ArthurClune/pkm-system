// pattern: Imperative Shell
// The startup poison gate and the poison repair, without React. SyncProvider
// creates one per replica-backed mount and feeds its sync events into the
// syncState core; anything else (a test harness) can drive it the same way.
//
// Startup closes the reload window in which later durable work could post
// before a previously rejected optimistic batch is repaired: delivery stays
// paused from startup() until either discovery finds nothing, a repair of
// what it found succeeds, or the replica proves unusable. Which Retry a click
// means is decided by retryPolicy.ts; runRetry only executes that decision.
import type { Replica } from "../replica/client";
import { availabilityOf } from "../replica/errors";
import type { OpQueue, PoisonEvent } from "./opQueue";
import type { ReplicaState, ReplicaSync } from "./replicaSync";
import type { RetryPlan } from "./retryPolicy";
import type { SyncEvent } from "./syncState";

/** Every retained or discovered poison event once, in row order. */
export const mergePoisonEvents = (
  ...groups: ReadonlyArray<readonly PoisonEvent[]>
): PoisonEvent[] => {
  const merged = new Map<string, PoisonEvent>();
  groups.flat().forEach((event) => {
    merged.set(`${event.id}\u0000${event.batch_id}`, event);
  });
  return [...merged.values()].sort((a, b) =>
    a.id - b.id || a.batch_id.localeCompare(b.batch_id));
};

export interface ClientRuntimeDeps {
  queue: Pick<OpQueue, "setOnline" | "pause" | "resume" | "retryPoisonMarks" |
    "refreshPending" | "discardPoisonIntents" | "onPoison" | "onPoisonMarkFailed">;
  replica: Pick<Replica, "poisonedBatches" | "deleteBatch">;
  replicaSync: Pick<ReplicaSync, "start" | "rebaseAuthoritative" |
    "completeAuthoritativeRepair">;
  /** SyncProvider passes applySync. */
  onSyncEvent: (event: SyncEvent) => void;
  /** The startup "no-replica" report for a replica that proved unusable. */
  onReplicaState: (state: ReplicaState) => void;
  /** An owner whose teardown lags its unmount: SyncProvider passes its
   * mountedRef, which turns false synchronously at unmount, while dispose()
   * waits a microtask so a StrictMode effect replay can keep the runtime.
   * Work in that gap is skipped exactly as after dispose(). */
  isMounted?: () => boolean;
}

export type PoisonRetryPlan = Exclude<RetryPlan, { kind: "legacy-repair" }>;

export interface ClientRuntime {
  /** The startup effect's body: setOnline(false), pause, retryPoisonMarks,
   * then continueStartup. Resolves with startupRun(). */
  startup(): Promise<void>;
  /** The promise of the current/last startup run (useSocketLifecycle's
   * startupRun); resolved before the first startup(). */
  startupRun(): Promise<void>;
  /** Discovery after marking: repair every marked or discovered poison row,
   * or resume delivery when there is none, then start the replica sync. */
  continueStartup(marked: readonly PoisonEvent[]): Promise<void>;
  /** Repair these poison rows; joins (and widens) a repair already running. */
  repair(events: readonly PoisonEvent[]): Promise<void>;
  /** Execute a planRetry() result for the poison-side plans; "legacy-repair"
   * stays with SyncProvider. */
  runRetry(plan: PoisonRetryPlan): Promise<void>;
  /** Give up on retained mark intents and release the barrier they held. */
  discardPoisonIntents(): Promise<void>;
  /** Forget the retained repair targets (a dismissed repaired problem). */
  clearRepairTargets(): void;
  /** True until startup discovery has run to a definite answer. */
  discoveringPoison(): boolean;
  /** Unsubscribes onPoison / onPoisonMarkFailed; afterwards no callback
   * fires and no queue.resume or replicaSync.start is called. */
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
  let repairRun: Promise<void> | null = null;
  let repairTargets: readonly PoisonEvent[] = [];
  let repairSucceeded = false;
  let discovering = true;

  const repair = (events: readonly PoisonEvent[]): Promise<void> => {
    if (events.length === 0) return Promise.resolve();
    if (repairRun) {
      repairTargets = mergePoisonEvents(repairTargets, events);
      return repairRun;
    }
    repairTargets = mergePoisonEvents(events);
    repairSucceeded = false;
    const event = repairTargets[0];
    emit({ type: "repair-started", event });
    const run = (async () => {
      try {
        await replicaSync.rebaseAuthoritative("poison");
        for (const poisonEvent of repairTargets) {
          await replica.deleteBatch(poisonEvent.id, poisonEvent.batch_id);
        }
        if (live()) {
          // The queue is the only publisher of the pending count;
          // refreshPending is the door for an outside re-read of the durable
          // table (see opQueue's emitPending).
          void queue.refreshPending();
          emit({ type: "repair-succeeded", event });
        }
        replicaSync.completeAuthoritativeRepair("poison");
        if (live()) queue.resume("recovery");
        repairSucceeded = true;
      } catch (error: unknown) {
        emit({ type: "repair-failed", event, error: messageOf(error) });
      }
    })();
    repairRun = run.finally(() => { repairRun = null; });
    return repairRun;
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
        const message = messageOf(error);
        if (availabilityOf(error) === "unusable") {
          discovering = false;
          // Report the mode directly, exactly as SyncProvider's null-replica
          // path does. There is nothing to "mark": the worker has latched the
          // fact, and every later replica call — including the start() a
          // reconnect triggers — replays it.
          if (live()) {
            deps.onReplicaState({ mode: "no-replica" });
            queue.resume("recovery");
          }
          // Not silent: the user has lost offline editing for the session and
          // gets no other signal, since "no-replica" raises no banner of its
          // own.
          emit({ type: "replica-unusable", error: message });
          return;
        }
        emit({ type: "poison-discovery-failed", error: message });
        return;
      }
      // Returned mark evidence is sufficient to repair those rows safely;
      // never discard it merely because the broader discovery read failed.
    }
    const repairable = mergePoisonEvents(marked, discovered);
    discovering = false;
    if (repairable.length > 0) {
      await repair(repairable);
      if (!repairSucceeded) return;
    } else {
      emit({ type: "poison-discovery-cleared" });
      if (live()) queue.resume("recovery");
    }
    if (live()) await replicaSync.start();
  };

  // Every Retry path ends the same way, and the condition is the point: the
  // replica may only resume syncing once a repair actually succeeded — a
  // restart after a failed one would sync past rows still awaiting repair.
  const restartAfterRepair = async (): Promise<void> => {
    if (repairSucceeded && live()) await replicaSync.start();
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
      emit({ type: "poison-mark-failed", event, error: messageOf(error) });
    }),
  ];

  return {
    startup: () => {
      queue.setOnline(false);
      queue.pause("recovery");
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
    runRetry: (plan) => {
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
            await (repairRun ?? Promise.resolve());
            await restartAfterRepair();
          })();
        case "continue-startup":
          return continueStartup([]);
        case "repair-targets":
          return repair(repairTargets).then(restartAfterRepair);
        case "none":
          return Promise.resolve();
      }
    },
    discardPoisonIntents: () => {
      queue.discardPoisonIntents();
      emit({ type: "poison-intents-discarded" });
      // Releases a claim this session may be holding from a rejection that
      // has not yet re-entered rejectDurableBatch; harmless when no claim is
      // held (completeAuthoritativeRepair only clears its own matching
      // reason).
      replicaSync.completeAuthoritativeRepair("poison");
      if (discovering) {
        // Rejoin the normal startup: discovery runs against the replica,
        // and an unopenable one falls into the online-only fallback.
        return continueStartup([]);
      }
      // Mid-session the still-unmarked durable row is simply handed out
      // again once the barrier lifts: the server rejects it again and the
      // flow re-enters rejectDurableBatch, whose per-batch effects are
      // idempotent across repeats (rememberPoisonMark).
      if (live()) queue.resume("recovery");
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
