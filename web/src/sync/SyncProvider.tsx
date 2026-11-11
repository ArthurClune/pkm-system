// pattern: Imperative Shell
// Runs the sync session (session.ts) over the websocket and the
// worker-backed replica, and publishes what it reports as four contexts split
// by rate of change (see SyncContext below). status drives connectivity UI;
// resyncGeneration bumps whenever local state may have diverged (rejected
// batch, or reconnect after a gap): views refetch authoritative state via
// useResync. The provider keeps the React state, the owned worker, the offline
// gateway and the unload guard.
import { createContext, useContext, useEffect, useMemo, useRef, useState,
         type ReactNode } from "react";
import { apiFetch, setOfflineGateway } from "../api/client";
import { attachActiveOutlineWriteReplay, repairActiveOutlineSessions,
         trackActiveOutlineWrite } from "../outline/outlineSessions";
import { createReplica, type Replica } from "../replica/client";
import { toPortLike } from "../replica/rpc";
import { clientId } from "./opQueue";
import type { ReplicaState } from "./replicaSync";
import { createSyncSession, type SyncActions } from "./session";
import { computeEditability, type SyncStatus,
         type SyncProblem } from "./syncState";
import { useSocketLifecycle } from "./useSocketLifecycle";
import { useUnloadGuard } from "./unloadGuard";

export type { SyncStatus, SyncProblem } from "./syncState";
export type { SyncActions } from "./session";

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
   * is ready and local storage can still persist edits
   * (docs/architecture/sync-recovery.md § What the UI shows). */
  canEdit: boolean;
  /** Why editing is blocked, when it is. */
  readOnlyReason?: string;
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
  const mountedRef = useRef(true);
  // Written during render, so it lags a mode report by one render: until then
  // the gateway still sees the previous mode. The status it reads is the
  // session's, which a socket transition moves synchronously.
  const modeRef = useRef(replicaState.mode);
  modeRef.current = replicaState.mode;

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

  // One session for the provider's whole lifetime. Building it reports
  // nothing and starts no work, so StrictMode's discarded second build is
  // inert; the effects below start the kept one.
  const session = useMemo(() => createSyncSession({
    replica: replicaRef.current ?? null,
    clientId,
    fetchJson: apiFetch,
    outlines: {
      track: trackActiveOutlineWrite,
      attachReplay: attachActiveOutlineWriteReplay,
      repairSessions: repairActiveOutlineSessions,
    },
    isMounted: () => mountedRef.current,
    report: {
      status: setStatus,
      replicaState: setReplicaState,
      problem: setProblem,
      resync: () => setResyncGeneration((n) => n + 1),
      pending: setPending,
      unsentInMemory: setUnsentInMemory,
    },
  }), []);

  // Declared above useSocketLifecycle: a socket status before startup throws.
  useEffect(() => { void session.startup(); }, [session]);

  // Offline routing (docs/architecture/frontend.md § How reads and writes
  // flow): while the socket is down, apiFetch serves shimmed reads (and page
  // create) from the replica.
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
      offline: () => session.status() === "reconnecting",
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
          void session.queue.refreshPending();
        }
        return result;
      },
    });
    return () => setOfflineGateway(null);
  }, [session]);

  useSocketLifecycle({
    session,
    mountedRef,
    disposeOwned: () => {
      const owned = ownedReplicaRef.current;
      ownedReplicaRef.current = null;
      if (owned) void owned.replica.dispose();
    },
  });

  // Connected: editing always allowed (server-authoritative, as before).
  // Offline: allowed only with a ready replica, otherwise the editor is frozen
  // with a reason. The rule lives in the syncState core.
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

  // Nested rather than combined, most stable outermost. A change to one slice
  // re-renders that slice's consumers only; `children` is the same element
  // either way, so React skips the subtree it does not need.
  return (
    <SyncActionsContext.Provider value={session.actions}>
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
