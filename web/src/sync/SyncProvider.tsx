// pattern: Imperative Shell
// Ties the websocket and the op queue into one context. status drives the
// banner and read-only editing (spec: writes paused while disconnected —
// divergence impossible rather than merged). resyncSeq bumps whenever local
// state may have diverged (rejected batch, or reconnect after a gap):
// views refetch authoritative state via useResync.
import { createContext, useContext, useEffect, useMemo, useRef, useState,
         type ReactNode } from "react";
import type { BlockOp } from "../api/ops";
import { clientId, createOpQueue } from "./opQueue";
import { connectSocket, type WsBatch } from "./socket";

export type SyncStatus = "connecting" | "connected" | "reconnecting";

export interface Sync {
  status: SyncStatus;
  resyncSeq: number;
  enqueue(ops: BlockOp[]): void;
  /** Remote batches only — own echoes are filtered out here. */
  subscribe(fn: (batch: WsBatch) => void): () => void;
  /** Resolves once nothing is pending or in flight in the op queue. */
  idle(): Promise<void>;
}

export const SyncContext = createContext<Sync>({
  status: "connecting",
  resyncSeq: 0,
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

export function SyncProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const [resyncSeq, setResyncSeq] = useState(0);
  const subsRef = useRef(new Set<(b: WsBatch) => void>());
  const everConnectedRef = useRef(false);

  const queue = useMemo(
    () => createOpQueue(() => setResyncSeq((n) => n + 1)), []);

  useEffect(() => {
    const handle = connectSocket({
      onBatch: (batch) => {
        if (batch.client_id === clientId) return; // our own echo
        subsRef.current.forEach((fn) => fn(batch));
      },
      onStatus: (up) => {
        // Drive the queue's connectivity synchronously here (not via a status
        // effect, which would race child refetch effects): the pump must be
        // paused/resumed at the exact transition.
        queue.setOnline(up);
        if (up) {
          if (everConnectedRef.current) {
            // Reconnect after a gap: flush the preserved ops first, then bump
            // resyncSeq so views refetch state that already reflects them.
            // (setOnline(true) started the flush synchronously, so idle() now
            // waits for it.) Ordering it this way keeps the display from
            // briefly adopting pre-flush state and diverging from the server.
            void queue.idle().then(() => setResyncSeq((n) => n + 1));
          }
          everConnectedRef.current = true;
          setStatus("connected");
        } else {
          setStatus("reconnecting");
        }
      },
    });
    return () => handle.close();
  }, []);

  const api = useMemo<Sync>(() => ({
    status,
    resyncSeq,
    enqueue: (ops) => queue.enqueue(ops),
    subscribe: (fn) => {
      subsRef.current.add(fn);
      return () => { subsRef.current.delete(fn); };
    },
    idle: () => queue.idle(),
  }), [status, resyncSeq, queue]);

  return <SyncContext.Provider value={api}>{children}</SyncContext.Provider>;
}
