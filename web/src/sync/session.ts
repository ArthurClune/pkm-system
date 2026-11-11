// pattern: Imperative Shell
// The one composition of the sync parts, without React: the op queue, the
// replica sync, the client runtime (startup poison gate and poison repair),
// the outline repair and the reconnect flow, with the socket status,
// the first-connect gate and the delivery-health fold over transitionSync.
// SyncProvider runs it and publishes what it reports; the sync property
// harness runs the same session over its own transport.
//
// Building subscribes every listener but starts no work and calls no report:
// SyncProvider builds the session during render (StrictMode may build one it
// then discards), so all work begins at startup() and onSocketStatus, which
// only effects reach. Every listener and report checks live() first, because
// an owner's isMounted turns false at unmount, a microtask before the
// deferred dispose() a StrictMode replay may cancel.
import type { ClientId, RawTitle } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { OutlineReplayAction } from "../outline/outlineState";
import type { Replica } from "../replica/client";
import { ReplicaUnusableError } from "../replica/errors";
import { createClientRuntime } from "./clientRuntime";
import { createOutlineRepair } from "./outlineRepair";
import { createOpQueue, type OpQueue, type OpQueueDeps,
         type WriteTicket } from "./opQueue";
import { createReconnectFlow } from "./reconnectFlow";
import { createReplicaSync, ResetBlockedError, type ReplicaState,
         type ReplicaSync, type ReplicaSyncDeps } from "./replicaSync";
import { planRetry } from "./retryPolicy";
import type { WsBatch, WsSeq } from "./socket";
import { transitionSync, type SyncEvent, type SyncProblem, type SyncState,
         type SyncStatus } from "./syncState";

/** Everything callable. One object for the session's whole lifetime: every
 * outline keeps it in the dependencies of its handlers, its edit runner and
 * its DnD api, so a new identity here re-renders every mounted Journal day.
 * Each method reads the session's current state rather than closing over
 * rendered state, which is what makes that possible. */
export interface SyncActions {
  /** Retry the retained rejected-batch repair, if it failed. */
  retryProblem(): Promise<void>;
  /** Clear repaired details. Failed/running problems cannot be dismissed. */
  dismissProblem(): void;
  /** Give up on a mark-failed rejected batch: drop its retained intents and
   * release the recovery barrier they held. The escape from a
   * profile whose replica can never open — without it the intent can never
   * clear and every future session boots wedged. Safe to give up because the
   * unmarked batch redelivers if the replica ever opens again, and the server
   * rejects it back into the normal poison → repair flow. */
  discardProblem(): Promise<void>;
  /** Manual recovery for a stalled replica: flushes pending writes
   * then rebuilds from a fresh snapshot. Pass discardPending=true to proceed
   * even when the flush cannot be delivered. */
  resetReplica(discardPending?: boolean): Promise<void>;
  enqueue(ops: BlockOp[], scope?: readonly string[]): WriteTicket;
  attachOutlineReplay(ticket: WriteTicket, title: RawTitle,
                      replay: readonly OutlineReplayAction[]): void;
  /** Remote batches only — own echoes are filtered out here. */
  subscribe(fn: (batch: WsBatch) => void): () => void;
  /** Resolves when all accepted writes have finished persistence. */
  settled(): Promise<void>;
}

/** What a session without a replica reports, as its mode's error and as
 * absentReplica()'s every call. */
const NO_REPLICA = "no replica in this environment";

/** The queue always has a Replica; where there is none, this reports the same
 * permanent unavailability the worker reports for a database it could not open.
 * The queue latches that once and answers it by delivering online-only through
 * its in-memory lane — which is what a browser with no usable OPFS
 * already does, so "no replica at all" needs no second delivery path. Reachable
 * only where `Worker` is undefined (jsdom) or a test passes `replica={null}`; a
 * real browser always builds the worker-backed replica (SyncProvider's
 * defaultReplica). */
export function absentReplica(): Replica {
  const absent = async (): Promise<never> => {
    throw new ReplicaUnusableError(NO_REPLICA);
  };
  return {
    init: absent, applySnapshot: absent, applyChanges: absent,
    enqueue: absent, nextBatch: absent, pendingBatches: absent,
    poisonedBatches: absent, deleteBatch: absent, markPoisoned: absent,
    pendingCount: absent, localApi: absent, prepareRecovery: absent,
    commitRecovery: absent, abortRecovery: absent,
    diagnostics: absent, dispose: absent,
  };
}

/** The open outline editors: outline/outlineSessions.ts in the app. */
export interface OutlineHooks {
  track(ticket: WriteTicket, ops: readonly BlockOp[]): void;
  attachReplay(ticket: WriteTicket, title: RawTitle,
               replay: readonly OutlineReplayAction[]): void;
  /** outlineRepair's repairSessions. */
  repairSessions(onStable: () => void): Promise<void>;
}

/** Each is called only while the session is live. */
export interface SyncReports {
  status(status: SyncStatus): void;
  replicaState(state: ReplicaState): void;
  /** Only when the problem's identity changes. */
  problem(problem: SyncProblem | undefined): void;
  resync(): void;
  /** The queue's count; refreshPending is the only way to re-read it. */
  pending(n: number): void;
  unsentInMemory(n: number): void;
  /** Every event the session folds, in order. */
  event?(event: SyncEvent): void;
}

export interface SyncSessionDeps {
  /** null: no replica in this environment; the queue runs on
   * absentReplica() and delivers online-only. */
  replica: Replica | null;
  clientId: ClientId;
  fetchJson: ReplicaSyncDeps["fetchJson"];
  queue?: Omit<OpQueueDeps, "clientId">;
  retryBaseMs?: number;
  outlines: OutlineHooks;
  /** False between an unmount and its deferred dispose. */
  isMounted?: () => boolean;
  report: SyncReports;
}

export interface SyncSession {
  /** One object for the session's life. */
  readonly actions: SyncActions;
  readonly queue: OpQueue;
  readonly replicaSync: ReplicaSync | null;
  /** Once per session; a later call returns the first run. Resolves with
   * the runtime's startup run. */
  startup(): Promise<void>;
  /** The socket's status callback. Resolves when the connect's chain
   * settles and never rejects. Throws if called before startup(). */
  onSocketStatus(up: boolean): Promise<void>;
  onBatch(batch: WsBatch): void;
  onSeq(frame: WsSeq): void;
  status(): SyncStatus;
  replicaState(): ReplicaState;
  problem(): SyncProblem | undefined;
  /** Stops the replica sync, disposes the queue, then the runtime. The
   * replica stays its creator's to dispose. */
  dispose(): void;
}

export function createSyncSession(deps: SyncSessionDeps): SyncSession {
  const { replica, clientId, outlines, report } = deps;
  let disposed = false;
  const live = (): boolean => !disposed && (deps.isMounted?.() ?? true);

  let status: SyncStatus = "connecting";
  let replicaState: ReplicaState = { mode: "starting" };
  let syncState: SyncState = { problem: undefined };
  const subscribers = new Set<(batch: WsBatch) => void>();

  // The deterministic delivery-health policy lives in transitionSync; this
  // keeps its state and reports the outcome. The state is updated before any
  // report, so a fold that a report itself triggers sees it.
  const fold = (event: SyncEvent): void => {
    if (!live()) return;
    const prev = syncState.problem;
    const transition = transitionSync(syncState, event);
    syncState = transition.state;
    report.event?.(event);
    if (transition.state.problem !== prev) report.problem(transition.state.problem);
    for (const effect of transition.effects) {
      if (effect.type === "bump-resync") report.resync();
    }
  };

  // Every mode writer reports here, so each report is folded with the mode it
  // replaces and the socket status of that moment.
  const reportMode = (next: ReplicaState): void => {
    if (!live()) return;
    const prev = replicaState.mode;
    replicaState = next;
    report.replicaState(next);
    fold({ type: "replica-state", prev, state: next, status });
  };

  const queue = createOpQueue(replica ?? absentReplica(),
                              { ...deps.queue, clientId });

  const outlineRepair = createOutlineRepair({
    repairSessions: (onStable) => outlines.repairSessions(onStable),
    onEvent: fold,
    resume: () => queue.resume("lane"),
    isMounted: live,
  });

  const replicaSync = replica === null ? null : createReplicaSync({
    replica,
    fetchJson: deps.fetchJson,
    clientId,
    queue,
    holdsPoison: () => queue.holds("poison"),
    // Same predicate as SyncProvider's offline gateway: a failed pull's retry
    // is pointless while the socket is down, and the reconnect's own start()
    // resumes it once the status flips back.
    isOffline: () => status === "reconnecting",
    onState: reportMode,
    retryBaseMs: deps.retryBaseMs,
  });

  // It subscribes the queue's poison signals itself.
  const runtime = replicaSync === null || replica === null ? null
    : createClientRuntime({
      queue,
      replica,
      replicaSync,
      onSyncEvent: fold,
      isMounted: live,
    });

  const reconnect = createReconnectFlow({
    queue,
    replicaSync,
    isMounted: live,
    onResync: () => report.resync(),
    // Either repair's failed last attempt is rerun by a connect. The poison
    // repair goes first: it holds the durable queue's recovery barrier.
    retryFailedRepair: async () => {
      await (runtime?.retryFailedRepair() ?? Promise.resolve());
      await outlineRepair.retryFailed();
    },
  });

  const offs = [
    queue.onDesync((desync) => {
      if (live()) void outlineRepair.run(desync.error, desync);
    }),
    // Either delivery path's ack named a skipped op: a replica-backed tab's
    // own feed tombstones the row, but nothing else bumps resync for it, so
    // this refetches regardless. Never a desync: the batch committed.
    queue.onSkipped(() => fold({ type: "ops-skipped" })),
    queue.onPending((n) => { if (live()) report.pending(n); }),
    queue.onUnsentInMemory((n) => { if (live()) report.unsentInMemory(n); }),
    // Drains completing out of band finish a reconnect waiting on them.
    queue.onDrain((outcome) => {
      if (live()) reconnect.observeDrain(outcome);
    }),
    // Not live-guarded: the latch emits once, and a StrictMode replay that
    // keeps the session must still know the replica is gone. The report
    // itself is guarded in reportMode.
    queue.onUnavailable((error) => replicaSync?.noteUnavailable(error)),
    // The recovery flush is a third POST path outside the queue's own
    // lane/drain, and its ack can name a skip too.
    ...(replicaSync === null ? []
      : [replicaSync.onSkipped(() => fold({ type: "ops-skipped" }))]),
  ];

  let startupRun: Promise<void> | null = null;
  let initialPending: Promise<number> | null = null;
  let everConnected = false;

  const startup = (): Promise<void> => {
    if (startupRun !== null) return startupRun;
    // A durable queue may be non-empty from a previous session. Asked of the
    // queue, not of the replica: report.pending has one writer, the queue's
    // listener, because the queue suppresses a re-emit of an unchanged count
    // and a second writer would turn that suppression into a stuck banner
    // (see opQueue's emitPending).
    if (replica !== null) void queue.refreshPending();
    if (runtime === null) {
      reportMode({ mode: "no-replica", error: NO_REPLICA });
      startupRun = Promise.resolve();
    } else {
      startupRun = runtime.startup();
    }
    // Leftovers from a previous page load (a reload can kill an in-flight
    // POST): read before the first connect can start draining them.
    initialPending = replica === null
      ? Promise.resolve(0) : queue.refreshPending();
    return startupRun;
  };

  const firstConnect = (pending: Promise<number>): Promise<void> =>
    pending.then(async (n) => {
      await (runtime?.startupRun() ?? Promise.resolve());
      // An unmount during the startup run: nothing may drain, start or repair
      // through a queue that is being disposed.
      if (!live()) return;
      // A first connect with a non-empty durable queue IS a reconnect after
      // a gap that spans page loads. Views have already fetched server state
      // that predates the flush, and the flushed batches echo back under
      // this tab's own clientId (filtered), so only the resync bump can
      // refresh them. `viewsAreStale` says so: the startup's catch-up may
      // already have absorbed the flush, leaving the reconnect's own cursor
      // comparison with nothing to report.
      //
      // A pending count of zero is not by itself proof there is nothing to
      // do: an offline cold start's startup run already tried
      // replicaSync.start(), and if its snapshot fetch failed for being
      // offline the replica never reached "ready". That failure is swallowed
      // in clientRuntime.startup, and a failed start arms no retry timer
      // while offline, so only this connect retries it. A replica that never
      // existed needs no such retry.
      const needsBootstrap = replicaSync !== null && !replicaSync.hasStarted();
      if (n > 0 || needsBootstrap) {
        await reconnect.begin({ viewsAreStale: true });
      }
    }).catch((error: unknown) => {
      console.error("first-connect reconnect.begin() failed", error);
    });

  const onSocketStatus = (up: boolean): Promise<void> => {
    if (initialPending === null) {
      throw new Error("sync session: socket status before startup()");
    }
    // The queue's connectivity is driven synchronously here, never from a
    // status effect, which would race child refetch effects.
    queue.setOnline(up);
    status = up ? "connected" : "reconnecting";
    let chain = Promise.resolve();
    if (up) {
      // begin() does not swallow: a throw inside it (a non-availability
      // replicaSync.start() failure) must not become an unhandled rejection.
      chain = everConnected
        ? reconnect.begin().catch((error: unknown) => {
          console.error("reconnect.begin() failed", error);
        })
        : firstConnect(initialPending);
      everConnected = true;
    }
    if (live()) report.status(status);
    return chain;
  };

  const actions: SyncActions = {
    retryProblem: () => {
      // Which recovery this click means is a pure decision (retryPolicy.ts);
      // its execution belongs to the runtime, except the outline
      // repair. With no runtime, startup never ran, so its gate still counts
      // as up.
      const plan = planRetry(syncState.problem, {
        startupDiscoveringPoison: runtime?.discoveringPoison() ?? true,
      });
      if (plan.kind === "outline-repair") {
        return outlineRepair.run(outlineRepair.rejected());
      }
      return runtime?.runRetry(plan) ?? Promise.resolve();
    },
    discardProblem: () => {
      const current = syncState.problem;
      if (current?.kind !== "rejected-batch" ||
          current.repair !== "mark-failed") return Promise.resolve();
      return runtime?.discardPoisonIntents() ?? Promise.resolve();
    },
    dismissProblem: () => {
      const current = syncState.problem;
      if (current?.kind === "outline-rejected" && current.repair === "repaired") {
        outlineRepair.clear();
      } else if (current?.kind === "rejected-batch" &&
          current.repair === "repaired") {
        runtime?.clearRepairTargets();
      } else if (current?.kind === "replica-stalled" &&
          (current.reset === "blocked" || current.reset === "failed")) {
        // Acknowledging a blocked or failed reset only clears the banner: a
        // later stall report raises it afresh (syncState's "dismiss").
      } else {
        return;
      }
      fold({ type: "dismiss" });
    },
    resetReplica: async (discardPending = false) => {
      fold({ type: "reset-started" });
      try {
        await replicaSync?.resetLocalData({ discardPending });
        fold({ type: "reset-succeeded" });
      } catch (e: unknown) {
        if (e instanceof ResetBlockedError) {
          fold({ type: "reset-blocked", pending: e.pending });
        } else {
          fold({ type: "reset-failed", error: String(e) });
        }
      }
    },
    enqueue: (ops, scope) => {
      const ticket = queue.enqueue(ops, scope);
      outlines.track(ticket, ops);
      return ticket;
    },
    attachOutlineReplay: (ticket, title, replay) => {
      outlines.attachReplay(ticket, title, replay);
    },
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
    settled: () => queue.settled(),
  };

  return {
    actions,
    queue,
    replicaSync,
    startup,
    onSocketStatus,
    onBatch: (batch) => {
      if (batch.client_id === clientId) return; // our own echo
      subscribers.forEach((fn) => fn(batch));
    },
    onSeq: (frame) => replicaSync?.onSeq(frame.seq, frame.force === true),
    status: () => status,
    replicaState: () => replicaState,
    problem: () => syncState.problem,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // A stopped instance's in-flight pull may still finish, but must not
      // reschedule another backoff retry that outlives the session.
      replicaSync?.stop();
      queue.dispose();
      runtime?.dispose();
      offs.forEach((off) => off());
    },
  };
}
