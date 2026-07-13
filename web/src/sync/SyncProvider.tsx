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
import { clientId, createOpQueue } from "./opQueue";
import { createReplicaSync, type ReplicaState } from "./replicaSync";
import { connectSocket, type WsBatch } from "./socket";

export type SyncStatus = "connecting" | "connected" | "reconnecting";

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
  enqueue(ops: BlockOp[]): void;
  /** Remote batches only — own echoes are filtered out here. */
  subscribe(fn: (batch: WsBatch) => void): () => void;
  /** Resolves once nothing is pending or in flight in the op queue. */
  idle(): Promise<void>;
}

export const SyncContext = createContext<Sync>({
  status: "connecting",
  resyncSeq: 0,
  replicaMode: "starting",
  canEdit: false,
  pending: 0,
  enqueue: () => {
    // a silent default would drop writes without a trace
    throw new Error("enqueue called outside <SyncProvider>");
  },
  subscribe: () => () => undefined,
  idle: () => Promise.resolve(),
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
function defaultReplica(): Replica | null {
  if (typeof Worker === "undefined") return null;
  const worker = new Worker(new URL("../replica/worker.ts", import.meta.url),
                            { type: "module" });
  return createReplica(toPortLike(worker));
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
  const subsRef = useRef(new Set<(b: WsBatch) => void>());
  const everConnectedRef = useRef(false);

  const replicaRef = useRef<Replica | null | undefined>(undefined);
  if (replicaRef.current === undefined) {
    replicaRef.current = replica === undefined ? defaultReplica() : replica;
  }

  const queue = useMemo(
    () => createOpQueue(replicaRef.current ?? null,
                        () => setResyncSeq((n) => n + 1)), []);

  useEffect(() => {
    const offs = [
      queue.onPending(setPending),
      queue.onQuota(() => setQuotaExhausted(true)),
    ];
    // a durable queue may be non-empty from a previous session
    void replicaRef.current?.pendingCount()
      .then(setPending).catch(() => undefined);
    return () => { offs.forEach((off) => off()); };
  }, [queue]);
  const replicaSync = useMemo(() => {
    const r = replicaRef.current;
    return r ? createReplicaSync({
      replica: r,
      fetchJson: apiFetch,
      clientId,
      onState: setReplicaState,
    }) : null;
  }, []);

  useEffect(() => {
    if (replicaSync === null) setReplicaState({ mode: "no-replica" });
  }, [replicaSync]);

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
          void r.pendingCount().then(setPending).catch(() => undefined);
        }
        return result;
      },
    });
    return () => setOfflineGateway(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Leftovers from a previous page load (a reload can kill an in-flight
    // POST): read before the first connect can start draining them.
    const initialPending: Promise<number> =
      replicaRef.current?.pendingCount().catch(() => 0) ?? Promise.resolve(0);
    // Reconnect after a gap: flush the preserved ops first, then pull the
    // changes feed, then bump resyncSeq so views refetch state that already
    // reflects both (flush -> pull -> resync).
    const reconnectFlow = () => queue.idle()
      .then(() => replicaSync?.start())
      .then(() => replicaSync?.idle())
      .then(() => setResyncSeq((n) => n + 1));
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
            void initialPending.then((n) =>
              n > 0 ? reconnectFlow() : replicaSync?.start());
          }
          everConnectedRef.current = true;
          setStatus("connected");
        } else {
          setStatus("reconnecting");
        }
      },
    });
    return () => handle.close();
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
    enqueue: (ops) => queue.enqueue(ops),
    subscribe: (fn) => {
      subsRef.current.add(fn);
      return () => { subsRef.current.delete(fn); };
    },
    idle: () => queue.idle(),
  }), [status, resyncSeq, replicaState, canEdit, pending, readOnlyReason,
       queue]);

  return <SyncContext.Provider value={api}>{children}</SyncContext.Provider>;
}
