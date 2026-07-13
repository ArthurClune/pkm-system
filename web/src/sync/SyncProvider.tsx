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
import { apiFetch } from "../api/client";
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
  const subsRef = useRef(new Set<(b: WsBatch) => void>());
  const everConnectedRef = useRef(false);

  const queue = useMemo(
    () => createOpQueue(() => setResyncSeq((n) => n + 1)), []);

  const replicaRef = useRef<Replica | null | undefined>(undefined);
  if (replicaRef.current === undefined) {
    replicaRef.current = replica === undefined ? defaultReplica() : replica;
  }
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

  useEffect(() => {
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
        if (up) {
          if (everConnectedRef.current) {
            // Reconnect after a gap: flush the preserved ops first, then pull
            // the changes feed, then bump resyncSeq so views refetch state
            // that already reflects both (flush -> pull -> resync).
            void queue.idle()
              .then(() => replicaSync?.start())
              .then(() => replicaSync?.idle())
              .then(() => setResyncSeq((n) => n + 1));
          } else {
            void replicaSync?.start();
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

  const api = useMemo<Sync>(() => ({
    status,
    resyncSeq,
    replicaMode: replicaState.mode,
    enqueue: (ops) => queue.enqueue(ops),
    subscribe: (fn) => {
      subsRef.current.add(fn);
      return () => { subsRef.current.delete(fn); };
    },
    idle: () => queue.idle(),
  }), [status, resyncSeq, replicaState, queue]);

  return <SyncContext.Provider value={api}>{children}</SyncContext.Provider>;
}
