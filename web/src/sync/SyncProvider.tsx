// pattern: Imperative Shell
// Ties the websocket, the op queue and the replica together, and publishes
// them as four contexts split by rate of change (see SyncContext below).
// status drives connectivity UI; resyncGeneration bumps whenever local
// state may have diverged (rejected batch, or reconnect after a gap):
// views refetch authoritative state via useResync. The replica is kept warm
// from the changes feed via WS seq nudges; reconnect ordering is flush
// pending ops -> pull feed -> resync bump (spec sections 3/6).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef,
         useState, type ReactNode } from "react";
import type { BlockOp } from "../api/ops";
import { apiFetch, setOfflineGateway } from "../api/client";
import { attachActiveOutlineWriteReplay, repairActiveOutlineSessions,
         trackActiveOutlineWrite } from "../outline/outlineSessions";
import type { OutlineReplayAction } from "../outline/outlineState";
import { createReplica, type Replica } from "../replica/client";
import { ReplicaUnusableError } from "../replica/errors";
import { toPortLike } from "../replica/rpc";
import { createClientRuntime } from "./clientRuntime";
import { clientId, createOpQueue, type WriteTicket } from "./opQueue";
import { createReplicaSync, ResetBlockedError, type ReplicaState } from "./replicaSync";
import { planRetry } from "./retryPolicy";
import type { WsBatch } from "./socket";
import { computeEditability, transitionSync,
         type SyncEvent, type SyncStatus, type SyncProblem } from "./syncState";
import { useSocketLifecycle } from "./useSocketLifecycle";
import { useUnloadGuard } from "./unloadGuard";

export type { SyncStatus, SyncProblem } from "./syncState";

/** Connectivity and delivery health: the half that churns. `pending` moves at
 * least twice per flushed edit, so it must not share an identity with the
 * actions below — see the context split under SyncContext. */
export interface SyncHealth {
  status: SyncStatus;
  /** Replica lifecycle (offline support): "no-replica" means the app runs
   * online-only exactly as before the replica existed. */
  replicaMode: ReplicaState["mode"];
  /** Queued (non-poisoned) batches not yet acknowledged by the server. */
  pending: number;
  /** Ops stranded ONLY in this tab's memory — the subset of `pending` a
   * reload actually destroys. Durable replica rows count toward
   * `pending` too but survive a reload fine, which is why the beforeunload
   * guard (wired in SyncProvider, not here) is gated on this and not on
   * `pending`. */
  unsentInMemory: number;
  /** Delivery health is separate from websocket connectivity. */
  problem?: SyncProblem;
}

/** Whether editing is allowed, and why not. Its own slice because a socket
 * flap with a ready replica leaves it unchanged, and an outline must not
 * re-render for a change that cannot alter what it may do. */
export interface SyncEditability {
  /** Editing allowed: always when connected; offline only when the replica
   * is ready and local storage can still persist edits (spec section 6). */
  canEdit: boolean;
  /** Why editing is blocked, when it is. */
  readOnlyReason?: string;
}

/** Everything callable. One object for the provider's whole lifetime: every
 * outline keeps it in the dependencies of its handlers, its edit runner and
 * its DnD api, so a new identity here re-renders every mounted Journal day.
 * Each method reads the freshest state through a ref rather than
 * closing over rendered state, which is what makes that possible. */
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
  /** Manual recovery for a stalled replica (Fix A): flushes pending writes
   * then rebuilds from a fresh snapshot. Pass discardPending=true to proceed
   * even when the flush cannot be delivered. */
  resetReplica(discardPending?: boolean): Promise<void>;
  enqueue(ops: BlockOp[], scope?: readonly string[]): WriteTicket;
  attachOutlineReplay(ticket: WriteTicket, title: string,
                      replay: readonly OutlineReplayAction[]): void;
  /** Remote batches only — own echoes are filtered out here. */
  subscribe(fn: (batch: WsBatch) => void): () => void;
  /** Resolves when all accepted writes have finished persistence. */
  settled(): Promise<void>;
}

/** The whole surface in one object. No component takes it — each reads the
 * slice it needs through the hooks below — but a test fake supplies it
 * wholesale through SyncContext, and that fake has to satisfy every slice. */
export interface Sync extends SyncActions, SyncHealth, SyncEditability {
  resyncGeneration: number;
}

const DEFAULT_ACTIONS: SyncActions = {
  retryProblem: () => Promise.resolve(),
  dismissProblem: () => undefined,
  discardProblem: () => Promise.resolve(),
  resetReplica: () => Promise.resolve(),
  enqueue: () => {
    // a silent default would drop writes without a trace
    throw new Error("enqueue called outside <SyncProvider>");
  },
  attachOutlineReplay: () => undefined,
  subscribe: () => () => undefined,
  settled: () => Promise.resolve(),
};
const DEFAULT_HEALTH: SyncHealth = {
  status: "connecting", replicaMode: "starting", pending: 0, unsentInMemory: 0,
};
const DEFAULT_EDITABILITY: SyncEditability = { canEdit: false };

// Four contexts rather than one, because React has no way to subscribe to part
// of a context value: whatever shares an identity with `pending` re-renders
// twice per flushed edit, and in the Journal that is every mounted outline.
// Ordered here from most to least stable.
const SyncActionsContext = createContext<SyncActions>(DEFAULT_ACTIONS);
const ResyncContext = createContext(0);
const SyncEditabilityContext =
  createContext<SyncEditability>(DEFAULT_EDITABILITY);
const SyncHealthContext = createContext<SyncHealth>(DEFAULT_HEALTH);

/** A complete Sync value to inject wholesale — how tests supply a fake
 * (`test-helpers`' makeSync). SyncProvider deliberately does not publish this:
 * it publishes the four slices instead. Every hook below prefers this when it
 * is set, so a one-object fake still satisfies a consumer that reads slices. */
export const SyncContext = createContext<Sync | null>(null);

export function useSyncActions(): SyncActions {
  const whole = useContext(SyncContext);
  const actions = useContext(SyncActionsContext);
  return whole ?? actions;
}

export function useSyncHealth(): SyncHealth {
  const whole = useContext(SyncContext);
  const health = useContext(SyncHealthContext);
  return whole ?? health;
}

export function useSyncEditability(): SyncEditability {
  const whole = useContext(SyncContext);
  const editability = useContext(SyncEditabilityContext);
  return whole ?? editability;
}

export function useResyncGeneration(): number {
  const whole = useContext(SyncContext);
  const seq = useContext(ResyncContext);
  return whole?.resyncGeneration ?? seq;
}

/** Run fn whenever resyncGeneration changes (not on mount). */
export function useResync(fn: () => void): void {
  const resyncGeneration = useResyncGeneration();
  const seen = useRef(resyncGeneration);
  useEffect(() => {
    if (resyncGeneration !== seen.current) {
      seen.current = resyncGeneration;
      fn();
    }
  }, [resyncGeneration, fn]);
}

/** The real worker-backed replica; null where Workers don't exist (jsdom). */
interface OwnedReplica {
  replica: Replica;
  worker: Worker;
}

function defaultReplica(): OwnedReplica | null {
  if (typeof Worker === "undefined") return null;
  const worker = new Worker(new URL("../replica/worker.ts", import.meta.url),
                            { type: "module" });
  return {
    worker,
    replica: createReplica(toPortLike(worker), () => worker.terminate()),
  };
}

/** The queue always has a Replica; where there is none, this reports the same
 * permanent unavailability the worker reports for a database it could not open.
 * The queue latches that once and answers it by delivering online-only through
 * its in-memory lane — which is what a browser with no usable OPFS
 * already does, so "no replica at all" needs no second delivery path. Reachable
 * only where `Worker` is undefined (jsdom) or a test passes `replica={null}`; a
 * real browser always builds the worker-backed replica above. */
function absentReplica(): Replica {
  const absent = async (): Promise<never> => {
    throw new ReplicaUnusableError("no replica in this environment");
  };
  return {
    init: absent, applySnapshot: absent, applyChanges: absent,
    enqueue: absent, nextBatch: absent, pendingBatches: absent,
    poisonedBatches: absent, deleteBatch: absent, markPoisoned: absent,
    pendingCount: absent, localApi: absent, prepareRecovery: absent,
    commitRecovery: absent, abortRecovery: absent, reset: absent,
    diagnostics: absent, dispose: absent,
  };
}

export function SyncProvider({ children, replica }: {
  children: ReactNode;
  /** Injectable for tests; defaults to the worker-backed replica. */
  replica?: Replica | null;
}) {
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const [resyncGeneration, setResyncGeneration] = useState(0);
  const [replicaState, setReplicaState] =
    useState<ReplicaState>({ mode: "starting" });
  const [pending, setPending] = useState(0);
  const [unsentInMemory, setUnsentInMemory] = useState(0);
  const [problem, setProblem] = useState<SyncProblem>();
  const subsRef = useRef(new Set<(b: WsBatch) => void>());
  const mountedRef = useRef(true);
  // Declared here, above every closure that reads them, so no later
  // reordering can leave one in its temporal dead zone. Both are written
  // synchronously rather than derived from state: the offline gateway's
  // decisions and the replica-state callback must not lag a transition by a
  // React render (a bootstrap fetch fires inside the socket-open handler,
  // before state has re-rendered). `statusRef` is written in the socket
  // lifecycle's onStatus; `modeRef` on every render, just below.
  const statusRef = useRef<SyncStatus>("connecting");
  const modeRef = useRef(replicaState.mode);
  modeRef.current = replicaState.mode;
  const legacyRepairRunRef = useRef<Promise<void> | null>(null);
  const legacyRejectedRef = useRef<unknown>();
  const problemRef = useRef<SyncProblem>();
  problemRef.current = problem;

  // Route the deterministic delivery-health policy through the syncState core:
  // it computes the next problem value and any resync intent; this shell keeps
  // the mounted guard, the async orchestration, and the queue/replica I/O. The
  // current problem is read from problemRef (the last rendered value), matching
  // the former inline setProblem call sites.
  // Stable (refs and setState only): the actions value memoises on it, and
  // that value must survive the provider's whole lifetime.
  const applySync = useCallback((event: SyncEvent): void => {
    const prev = problemRef.current;
    const transition = transitionSync({ problem: prev }, event);
    if (!mountedRef.current) return;
    if (transition.state.problem !== prev) {
      // Update the ref immediately (not just on next render): a second
      // applySync dispatched in the same tick (e.g. from a listener firing
      // synchronously off this one) must see this problem, not the one
      // still pending in React's batched state update.
      problemRef.current = transition.state.problem;
      setProblem(transition.state.problem);
    }
    for (const effect of transition.effects) {
      if (effect.type === "bump-resync") setResyncGeneration((n) => n + 1);
    }
  }, []);

  const replicaRef = useRef<Replica | null | undefined>(undefined);
  const ownedReplicaRef = useRef<OwnedReplica | null>(null);
  if (replicaRef.current === undefined) {
    if (replica === undefined) {
      ownedReplicaRef.current = defaultReplica();
      replicaRef.current = ownedReplicaRef.current?.replica ?? null;
    } else {
      replicaRef.current = replica;
    }
  }

  // One stable instance for the provider's whole lifetime; its signals are
  // subscribed in the effects below (see opQueue.ts's header for why none can
  // be missed).
  const queue = useMemo(
    () => createOpQueue(replicaRef.current ?? absentReplica()), []);

  // Stable (refs, applySync and the queue only): the desync listener and the
  // legacy-repair Retry both call it, and the actions value memoises on it.
  const repairLegacy = useCallback((error: unknown): Promise<void> => {
    legacyRejectedRef.current = error;
    if (legacyRepairRunRef.current) return legacyRepairRunRef.current;
    const message = error instanceof Error ? error.message : String(error);
    applySync({ type: "legacy-repair-started", error: message });
    const run = repairActiveOutlineSessions(() => {
        if (!mountedRef.current) return;
        applySync({ type: "legacy-repair-succeeded", error: message });
        queue.resume("recovery");
      })
      .catch((repairError: unknown) => {
        applySync({
          type: "legacy-repair-failed", error: message,
          repairError: repairError instanceof Error
            ? repairError.message : String(repairError),
        });
      });
    legacyRepairRunRef.current = run.finally(() => {
      legacyRepairRunRef.current = null;
    });
    return legacyRepairRunRef.current;
  }, [applySync, queue]);

  useEffect(() => {
    const offs = [
      queue.onDesync((error) => { void repairLegacy(error); }),
      // Either delivery path's ack named a skipped op: a replica-backed
      // tab's own feed tombstones the row, but nothing else bumps resync
      // for it, so this refetches regardless. Never a desync -- the batch
      // committed -- so this bumps resync only.
      queue.onSkipped(() => applySync({ type: "ops-skipped" })),
      queue.onPending((n) => { if (mountedRef.current) setPending(n); }),
      queue.onUnsentInMemory((n) => {
        if (mountedRef.current) setUnsentInMemory(n);
      }),
    ];
    // A durable queue may be non-empty from a previous session. Asked of the
    // queue, not of the replica: setPending has exactly one caller — the
    // listener above — because the queue suppresses a re-emit of an unchanged
    // count, and a second writer of this state would silently turn that
    // suppression into a stuck banner (see opQueue's emitPending).
    if (replicaRef.current) void queue.refreshPending();
    return () => { offs.forEach((off) => off()); };
  }, [applySync, queue, repairLegacy]);
  const replicaSync = useMemo(() => {
    const r = replicaRef.current;
    return r ? createReplicaSync({
      replica: r,
      fetchJson: apiFetch,
      clientId,
      queue,
      // Same predicate as the offline gateway below: a failed pull's retry
      // is pointless while the socket is down, and reconnect's
      // own start() call resumes it once statusRef flips back.
      isOffline: () => statusRef.current === "reconnecting",
      onState: (next) => {
        if (mountedRef.current) setReplicaState(next);
        // Delivery health (Fix A): a wedged replica or a failed recovery
        // while the socket is up both need the same stalled banner + reset
        // action; recovery-failed while offline keeps its existing
        // read-only-reason behavior instead (computeEditability). statusRef
        // (not the `status` state closed over at memo-creation time) is the
        // current socket status: this callback fires long after this memo
        // was built.
        if (next.mode === "stalled") {
          applySync({ type: "replica-stalled", error: next.error });
        } else if (next.mode === "ready") {
          applySync({ type: "replica-unstalled" });
        } else if (next.mode === "recovery-failed" &&
                   statusRef.current === "connected") {
          applySync({ type: "replica-stalled", error: next.error });
        }
      },
    }) : null;
    // queue and applySync are both mount-stable; listing them keeps this
    // memo honest without changing that replicaSync is created exactly once.
  }, [applySync, queue]);
  // The same skip handling the queue's listener has above: the recovery
  // flush is a third POST path outside the queue's own lane/drain, and its
  // ack can name a skip too.
  useEffect(() => replicaSync?.onSkipped(
    () => applySync({ type: "ops-skipped" })), [applySync, replicaSync]);

  // The startup poison gate and poison repair (clientRuntime.ts), one per
  // replica-backed mount. It subscribes the queue's poison signals itself and
  // is disposed with the queue in the socket lifecycle's deferred teardown,
  // so a StrictMode effect replay keeps it; mountedRef stops its work at the
  // unmount itself, a microtask before that.
  const runtime = useMemo(() => replicaSync === null ? null : createClientRuntime({
    queue,
    replica: replicaRef.current!,
    replicaSync,
    onSyncEvent: applySync,
    onReplicaState: (next) => { if (mountedRef.current) setReplicaState(next); },
    isMounted: () => mountedRef.current,
  }), [applySync, queue, replicaSync]);

  useEffect(() => {
    if (runtime === null) {
      setReplicaState({ mode: "no-replica" });
      return;
    }
    void runtime.startup();
  }, [runtime]);

  // Views that fetched while the replica was still starting got online-only
  // errors (or stale server state); once it turns ready with the socket
  // still down, only a resync bump can make them refetch through the shim.
  const prevModeRef = useRef(replicaState.mode);
  useEffect(() => {
    const was = prevModeRef.current;
    prevModeRef.current = replicaState.mode;
    // statusRef is a ref on purpose: this must react to MODE changes only
    applySync({
      type: "mode-ready-check", prevMode: was, mode: replicaState.mode,
      status: statusRef.current,
    });
  }, [applySync, replicaState.mode]);

  // Offline routing (spec section 4): while the socket is down, apiFetch
  // serves shimmed reads (and page create) from the replica. statusRef/modeRef
  // (declared at the top of the component) keep the gateway's view of
  // status/mode current without re-registering.
  useEffect(() => {
    const r = replicaRef.current;
    if (!r) return;
    setOfflineGateway({
      // only a DROPPED socket means offline. "connecting" (initial load,
      // reload) must reach the network: the socket handshake lags the first
      // fetches, and shimming those would serve stale local state that
      // nothing refetches (the first connect does not bump resyncGeneration). A
      // cold start that is truly offline is caught by apiFetch's
      // fetch-failure fallback instead.
      offline: () => statusRef.current === "reconnecting",
      handle: async (path, init) => {
        if (modeRef.current !== "ready") return { handled: false };
        const method = init?.method ?? "GET";
        const result = await r.localApi({
          method,
          path,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          nowMs: Date.now(),
        });
        if (result.handled && method !== "GET") {
          // A shim write (page create) enqueued a batch inside the worker, so
          // the durable count moved without the queue doing it: the queue has
          // to re-read it, because it is the only publisher of that count.
          void queue.refreshPending();
        }
        return result;
      },
    });
    return () => setOfflineGateway(null);
    // queue is mount-stable, so listing it does not re-register the gateway.
  }, [queue]);

  // Connect/reconnect lifecycle: mount-time pending bootstrap, the reconnect
  // single-flight protocol, drain observation, socket status, and
  // StrictMode-safe teardown (useSocketLifecycle.ts / reconnectFlow.ts).
  useSocketLifecycle({
    queue,
    replicaSync,
    // Leftovers from a previous page load (a reload can kill an in-flight
    // POST): read before the first connect can start draining them. Through
    // the queue, so this read also seeds and publishes the count instead of
    // being a second, private view of it.
    readInitialPending: () =>
      replicaRef.current ? queue.refreshPending() : Promise.resolve(0),
    startupRun: () => runtime?.startupRun() ?? Promise.resolve(),
    retryFailedRepair: () => runtime?.retryFailedRepair() ?? Promise.resolve(),
    mountedRef,
    statusRef,
    onBatch: (batch) => {
      if (batch.client_id === clientId) return; // our own echo
      subsRef.current.forEach((fn) => fn(batch));
    },
    onSeq: (frame) => replicaSync?.onSeq(frame.seq, frame.force === true),
    onStatus: setStatus,
    onResync: () => setResyncGeneration((n) => n + 1),
    disposeOwned: () => {
      runtime?.dispose();
      const owned = ownedReplicaRef.current;
      ownedReplicaRef.current = null;
      if (owned) void owned.replica.dispose();
    },
  });

  // Connected: editing always allowed (server-authoritative, as before).
  // Offline: allowed only with a ready replica, otherwise the editor is frozen
  // with a reason (spec section 6). The rule lives in the syncState core.
  const { canEdit, readOnlyReason } =
    computeEditability(status, replicaState.mode);

  // Live for the provider's whole lifetime, independent of whether any
  // banner component is mounted to show the corresponding copy.
  useUnloadGuard(unsentInMemory);

  const health = useMemo<SyncHealth>(
    () => ({ status, replicaMode: replicaState.mode, pending, unsentInMemory,
             problem }),
    [status, replicaState.mode, pending, unsentInMemory, problem]);
  // Value-equal by construction: both fields are primitives, so a flap that
  // does not change what the editor may do publishes the same identity.
  const editability = useMemo<SyncEditability>(
    () => ({ canEdit, readOnlyReason }), [canEdit, readOnlyReason]);

  // All five are created once per provider, so this value is too. The
  // methods reach current state through refs on purpose (see SyncActions).
  const actions = useMemo<SyncActions>(() => ({
    retryProblem: () => {
      // Which recovery this click means is a pure decision (retryPolicy.ts);
      // its execution — the queue, the replica and the startup gate —
      // belongs to the runtime, except the legacy outline repair. The
      // freshest problem is read from problemRef for the same reason
      // applySync does: a same-tick dispatch must not be judged against the
      // value still pending in React's batched state update. With no
      // runtime, startup never ran, so its gate still counts as up.
      const plan = planRetry(problemRef.current, {
        startupDiscoveringPoison: runtime?.discoveringPoison() ?? true,
      });
      if (plan.kind === "legacy-repair") {
        return repairLegacy(legacyRejectedRef.current);
      }
      return runtime?.runRetry(plan) ?? Promise.resolve();
    },
    discardProblem: () => {
      const currentProblem = problemRef.current;
      if (currentProblem?.kind !== "rejected-batch" ||
          currentProblem.repair !== "mark-failed") return Promise.resolve();
      return runtime?.discardPoisonIntents() ?? Promise.resolve();
    },
    dismissProblem: () => {
      const currentProblem = problemRef.current;
      if (currentProblem?.kind === "legacy-rejected" &&
          currentProblem.repair === "repaired") {
        legacyRejectedRef.current = undefined;
      } else if (currentProblem?.kind === "rejected-batch" &&
          currentProblem.repair === "repaired") {
        runtime?.clearRepairTargets();
      } else if (currentProblem?.kind === "replica-stalled" &&
          (currentProblem.reset === "blocked" || currentProblem.reset === "failed")) {
        // No local ref cleanup needed here: acknowledging a blocked/failed
        // reset just clears the banner — a later stall re-report re-raises
        // it fresh (see syncState's "dismiss"/"replica-stalled" handling).
      } else {
        return;
      }
      applySync({ type: "dismiss" });
    },
    resetReplica: async (discardPending = false) => {
      applySync({ type: "reset-started" });
      try {
        await replicaSync?.resetLocalData({ discardPending });
        applySync({ type: "reset-succeeded" });
      } catch (e: unknown) {
        if (e instanceof ResetBlockedError) {
          applySync({ type: "reset-blocked", pending: e.pending });
        } else {
          applySync({ type: "reset-failed", error: String(e) });
        }
      }
    },
    enqueue: (ops, scope) => {
      const ticket = queue.enqueue(ops, scope);
      trackActiveOutlineWrite(ticket, ops);
      return ticket;
    },
    attachOutlineReplay: (ticket, title, replay) => {
      attachActiveOutlineWriteReplay(ticket, title, replay);
    },
    subscribe: (fn) => {
      subsRef.current.add(fn);
      return () => { subsRef.current.delete(fn); };
    },
    settled: () => queue.settled(),
  }), [applySync, queue, replicaSync, repairLegacy, runtime]);

  // Nested rather than combined, most stable outermost. A change to one slice
  // re-renders that slice's consumers only; `children` is the same element
  // either way, so React skips the subtree it does not need.
  return (
    <SyncActionsContext.Provider value={actions}>
      <ResyncContext.Provider value={resyncGeneration}>
        <SyncEditabilityContext.Provider value={editability}>
          <SyncHealthContext.Provider value={health}>
            {children}
          </SyncHealthContext.Provider>
        </SyncEditabilityContext.Provider>
      </ResyncContext.Provider>
    </SyncActionsContext.Provider>
  );
}
