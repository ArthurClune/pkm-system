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
}

export const SyncContext = createContext<Sync>({
  status: "connecting",
  resyncSeq: 0,
  enqueue: () => {
    // a silent default would drop writes without a trace
    throw new Error("enqueue called outside <SyncProvider>");
  },
  subscribe: () => () => undefined,
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
        if (up) {
          if (everConnectedRef.current) setResyncSeq((n) => n + 1);
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
  }), [status, resyncSeq, queue]);

  return <SyncContext.Provider value={api}>{children}</SyncContext.Provider>;
}
