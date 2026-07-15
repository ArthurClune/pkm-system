// pattern: Imperative Shell
// Ties the websocket, the op queue and the replica into one context. status
// drives connectivity UI; resyncSeq bumps whenever local state may have
// diverged (rejected batch, or reconnect after a gap): views refetch
// authoritative state via useResync. The replica (pkm-y8p0) is kept warm
// from the changes feed via WS seq nudges; reconnect ordering is flush
// pending ops -> pull feed -> resync bump (spec sections 3/6).
import { createContext, useContext, useEffect, useMemo, useRef, useState,
         type ReactNode } from "react";
import type { BlockOp } from "../api/ops";
import { apiFetch, setOfflineGateway } from "../api/client";
import { createReplica, type Replica } from "../replica/client";
import { toPortLike } from "../replica/rpc";
import { clientId, createOpQueue, type DrainOutcome,
         type PoisonEvent, type WriteTicket } from "./opQueue";
import { createReplicaSync, type ReplicaState } from "./replicaSync";
import { connectSocket, type WsBatch } from "./socket";

export type SyncStatus = "connecting" | "connected" | "reconnecting";

export type SyncProblem =
  | { kind: "rejected-batch"; event: PoisonEvent;
      repair: "running" | "failed" | "repaired"; error?: string };

export interface Sync {
  status: SyncStatus;
  resyncSeq: number;
  /** Replica lifecycle (offline support): "no-replica" means the app runs
   * online-only exactly as before pkm-y8p0. */
  replicaMode: ReplicaState["mode"];
  /** Editing allowed: always when connected; offline only when the replica
   * is ready and local storage can still persist edits (spec section 6). */
  canEdit: boolean;
  /** Queued (non-poisoned) batches not yet acknowledged by the server. */
  pending: number;
  /** Why editing is blocked, when it is. */
  readOnlyReason?: string;
  /** Delivery health is separate from websocket connectivity. */
  problem?: SyncProblem;
  /** Retry the retained rejected-batch repair, if it failed. */
  retryProblem(): Promise<void>;
  /** Clear repaired details. Failed/running problems cannot be dismissed. */
  dismissProblem(): void;
  enqueue(ops: BlockOp[], scope?: readonly string[]): WriteTicket;
  /** Remote batches only — own echoes are filtered out here. */
  subscribe(fn: (batch: WsBatch) => void): () => void;
  /** Resolves when all accepted writes have finished persistence. */
  settled(): Promise<void>;
}

export const SyncContext = createContext<Sync>({
  status: "connecting",
  resyncSeq: 0,
  replicaMode: "starting",
  canEdit: false,
  pending: 0,
  retryProblem: () => Promise.resolve(),
  dismissProblem: () => undefined,
  enqueue: () => {
    // a silent default would drop writes without a trace
    throw new Error("enqueue called outside <SyncProvider>");
  },
  subscribe: () => () => undefined,
  settled: () => Promise.resolve(),
});

export function useSync(): Sync {
  return useContext(SyncContext);
}

/** Run fn whenever resyncSeq changes (not on mount). */
export function useResync(fn: () => void): void {
  const { resyncSeq } = useSync();
  const seen = useRef(resyncSeq);
  useEffect(() => {
    if (resyncSeq !== seen.current) {
      seen.current = resyncSeq;
      fn();
    }
  }, [resyncSeq, fn]);
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
  const [resyncSeq, setResyncSeq] = useState(0);
  const [replicaState, setReplicaState] =
    useState<ReplicaState>({ mode: "starting" });
  const [pending, setPending] = useState(0);
  const [quotaExhausted, setQuotaExhausted] = useState(false);
  const [problem, setProblem] = useState<SyncProblem>();
  const subsRef = useRef(new Set<(b: WsBatch) => void>());
  const everConnectedRef = useRef(false);
  const mountedRef = useRef(true);
  const drainObserverRef = useRef<(outcome: DrainOutcome) => void>(
    () => undefined);
  const startupRunRef = useRef<Promise<void>>(Promise.resolve());
  const repairRunRef = useRef<Promise<void> | null>(null);
  const repairTargetsRef = useRef<readonly PoisonEvent[]>([]);
  const repairSucceededRef = useRef(false);
  const problemRef = useRef<SyncProblem>();
  problemRef.current = problem;

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

  const queue = useMemo(
    () => createOpQueue(replicaRef.current ?? null, () => {
      if (mountedRef.current) setResyncSeq((n) => n + 1);
    }, (outcome) => drainObserverRef.current(outcome)), []);

  useEffect(() => {
    const offs = [
      queue.onPending((n) => { if (mountedRef.current) setPending(n); }),
      queue.onQuota(() => {
        if (mountedRef.current) setQuotaExhausted(true);
      }),
    ];
    // a durable queue may be non-empty from a previous session
    void replicaRef.current?.pendingCount()
      .then((n) => { if (mountedRef.current) setPending(n); })
      .catch(() => undefined);
    return () => { offs.forEach((off) => off()); };
  }, [queue]);
  const replicaSync = useMemo(() => {
    const r = replicaRef.current;
    return r ? createReplicaSync({
      replica: r,
      fetchJson: apiFetch,
      clientId,
      queue,
      onState: (next) => {
        if (mountedRef.current) setReplicaState(next);
      },
    }) : null;
  }, []);

  const repairEventsRef = useRef<(events: readonly PoisonEvent[]) => Promise<void>>(
    async () => undefined);
  repairEventsRef.current = (events) => {
    if (events.length === 0) return Promise.resolve();
    if (repairRunRef.current) return repairRunRef.current;
    repairTargetsRef.current = [...events];
    repairSucceededRef.current = false;
    const event = events[0];
    if (mountedRef.current) {
      setProblem({ kind: "rejected-batch", event, repair: "running" });
    }
    const run = (async () => {
      try {
        await replicaSync!.rebaseAuthoritative("poison");
        let remaining = 0;
        for (const poisonEvent of events) {
          const result = await replicaRef.current!.deleteBatch(poisonEvent.rowId);
          remaining = result.pending;
        }
        if (mountedRef.current) {
          setPending(remaining);
          setProblem({ kind: "rejected-batch", event, repair: "repaired" });
          setResyncSeq((n) => n + 1);
        }
        replicaSync!.completeAuthoritativeRepair("poison");
        if (mountedRef.current) {
          queue.resume("recovery");
        }
        repairSucceededRef.current = true;
      } catch (error: unknown) {
        if (mountedRef.current) {
          setProblem({
            kind: "rejected-batch", event, repair: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    repairRunRef.current = run.finally(() => { repairRunRef.current = null; });
    return repairRunRef.current;
  };

  useEffect(() => {
    if (replicaSync === null) {
      setReplicaState({ mode: "no-replica" });
      return;
    }
    const r = replicaRef.current!;
    // Close the reload window where later durable work could post before a
    // previously rejected optimistic batch is repaired.
    queue.setOnline(false);
    queue.pause("recovery");
    startupRunRef.current = (async () => {
      let poisoned: PoisonEvent[] = [];
      try { poisoned = await r.poisonedBatches(); } catch { /* init owns degradation */ }
      if (poisoned.length > 0) {
        await repairEventsRef.current(poisoned);
        if (!repairSucceededRef.current) return;
      } else {
        queue.resume("recovery");
      }
      // Start at mount, not just socket connect: a cold offline PWA with a
      // hydrated replica still becomes ready. Poison repair runs first so a
      // schema recovery cannot erase its durable details before repair.
      await replicaSync.start();
    })().catch(() => undefined);
  }, [queue, replicaSync]);

  useEffect(() => queue.onPoison((event) => {
    void repairEventsRef.current([event]);
  }), [queue]);

  // Views that fetched while the replica was still starting got online-only
  // errors (or stale server state); once it turns ready with the socket
  // still down, only a resync bump can make them refetch through the shim.
  const prevModeRef = useRef(replicaState.mode);
  useEffect(() => {
    const was = prevModeRef.current;
    prevModeRef.current = replicaState.mode;
    if (was !== "ready" && replicaState.mode === "ready"
        && statusRef.current !== "connected") {
      setResyncSeq((n) => n + 1);
    }
    // statusRef is a ref on purpose: this must react to MODE changes only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replicaState.mode]);

  // Offline routing (spec section 4): while the socket is down, apiFetch
  // serves shimmed reads (and page create) from the replica. Refs keep the
  // gateway's view of status/mode current without re-registering.
  // updated synchronously in onStatus: gateway decisions must not lag a
  // transition by a React render (a bootstrap fetch fires inside the
  // socket-open handler, before state has re-rendered)
  const statusRef = useRef<SyncStatus>("connecting");
  const modeRef = useRef(replicaState.mode);
  modeRef.current = replicaState.mode;
  useEffect(() => {
    const r = replicaRef.current;
    if (!r) return;
    setOfflineGateway({
      // only a DROPPED socket means offline. "connecting" (initial load,
      // reload) must reach the network: the socket handshake lags the first
      // fetches, and shimming those would serve stale local state that
      // nothing refetches (the first connect does not bump resyncSeq). A
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
          // a shim write (page create) enqueued a batch inside the worker
          void r.pendingCount()
            .then((n) => { if (mountedRef.current) setPending(n); })
            .catch(() => undefined);
        }
        return result;
      },
    });
    return () => setOfflineGateway(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // Leftovers from a previous page load (a reload can kill an in-flight
    // POST): read before the first connect can start draining them.
    const initialPending: Promise<number> =
      replicaRef.current?.pendingCount().catch(() => 0) ?? Promise.resolve(0);
    // Reconnect after a gap: flush the preserved ops first, then pull the
    // changes feed, then bump resyncSeq so views refetch state that already
    // reflects both (flush -> pull -> resync).
    let reconnectPending = false;
    let finishRun: Promise<void> | null = null;
    const finishReconnect = (): Promise<void> => {
      if (!mountedRef.current) return Promise.resolve();
      if (!reconnectPending) return finishRun ?? Promise.resolve();
      reconnectPending = false;
      if (finishRun) return finishRun;
      finishRun = (async () => {
        await replicaSync?.start();
        await replicaSync?.idle();
        if (mountedRef.current) setResyncSeq((n) => n + 1);
      })().finally(() => { finishRun = null; });
      return finishRun;
    };
    drainObserverRef.current = (outcome) => {
      if (outcome.status === "drained") {
        void finishReconnect().catch(() => undefined);
      }
    };
    const reconnectFlow = async (): Promise<void> => {
      reconnectPending = true;
      const outcome = await queue.drain();
      if (outcome.status !== "drained" || !mountedRef.current) return;
      await finishReconnect();
    };
    const handle = connectSocket({
      onBatch: (batch) => {
        if (batch.client_id === clientId) return; // our own echo
        subsRef.current.forEach((fn) => fn(batch));
      },
      onSeq: (frame) => replicaSync?.onSeq(frame.seq),
      onStatus: (up) => {
        // Drive the queue's connectivity synchronously here (not via a status
        // effect, which would race child refetch effects): the pump must be
        // paused/resumed at the exact transition.
        queue.setOnline(up);
        statusRef.current = up ? "connected" : "reconnecting";
        if (up) {
          if (everConnectedRef.current) {
            void reconnectFlow();
          } else {
            // A first connect with a non-empty durable queue IS a reconnect
            // after a gap — the gap just spans page loads. Views have already
            // fetched server state that predates the flush, and the flushed
            // batches echo back under this tab's own clientId (filtered), so
            // only the resync bump can refresh them.
            void initialPending.then(async (n) => {
              await startupRunRef.current;
              if (n > 0) await reconnectFlow();
            });
          }
          everConnectedRef.current = true;
          if (mountedRef.current) setStatus("connected");
        } else {
          if (mountedRef.current) setStatus("reconnecting");
        }
      },
    });
    return () => {
      mountedRef.current = false;
      drainObserverRef.current = () => undefined;
      handle.close();
      // React StrictMode immediately replays effects in development while
      // preserving memoized resources. Defer terminal ownership cleanup one
      // microtask so the replayed setup can keep them alive; a real unmount
      // leaves mountedRef false and performs cleanup exactly once.
      queueMicrotask(() => {
        if (mountedRef.current) return;
        queue.dispose();
        const owned = ownedReplicaRef.current;
        ownedReplicaRef.current = null;
        if (owned) void owned.replica.dispose();
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Connected: editing always allowed (server-authoritative, as before).
  // Offline: allowed only with a ready replica that can still persist —
  // quota exhaustion offline means an edit could be silently lost, so the
  // editor is frozen with a reason instead (spec section 6).
  const canEdit = status === "connected"
    || (replicaState.mode === "ready" && !quotaExhausted);
  const readOnlyReason = canEdit ? undefined
    : quotaExhausted ? "local storage is full — reconnect to sync"
    : replicaState.mode === "recovery-failed"
      ? "local data recovery failed — reconnect to continue"
      : "offline — this graph is not yet available locally";

  const api = useMemo<Sync>(() => ({
    status,
    resyncSeq,
    replicaMode: replicaState.mode,
    canEdit,
    pending,
    readOnlyReason,
    problem,
    retryProblem: () => {
      if (problemRef.current?.repair !== "failed") return Promise.resolve();
      return repairEventsRef.current(repairTargetsRef.current).then(async () => {
        if (repairSucceededRef.current) await replicaSync?.start();
      });
    },
    dismissProblem: () => {
      if (problemRef.current?.repair !== "repaired") return;
      repairTargetsRef.current = [];
      setProblem(undefined);
    },
    enqueue: (ops, scope) => queue.enqueue(ops, scope),
    subscribe: (fn) => {
      subsRef.current.add(fn);
      return () => { subsRef.current.delete(fn); };
    },
    settled: () => queue.settled(),
  }), [status, resyncSeq, replicaState, canEdit, pending, readOnlyReason,
       problem, queue]);

  return <SyncContext.Provider value={api}>{children}</SyncContext.Provider>;
}
