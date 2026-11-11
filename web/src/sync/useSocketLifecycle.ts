// pattern: Imperative Shell
// The websocket for SyncProvider's sync session (session.ts), and the
// session's StrictMode-safe teardown. The session owns everything a socket
// status means: the queue's connectivity, the first-connect gate and the
// reconnect protocol. Its status callback is driven synchronously from the
// socket, never from a status effect, which would race child refetch effects.
import { useEffect, useRef, type MutableRefObject } from "react";
import type { SyncSession } from "./session";
import { connectSocket } from "./socket";

export interface SocketLifecycleDeps {
  /** Mount-stable: the effect runs once per mount. */
  session: SyncSession;
  /** False after unmount (owned by the provider, which also guards on it). */
  mountedRef: MutableRefObject<boolean>;
  /** After session.dispose(): the worker-backed replica SyncProvider made. */
  disposeOwned: () => void;
}

export function useSocketLifecycle(deps: SocketLifecycleDeps): void {
  // Read through a ref so the effect below depends only on the session and
  // never re-runs on a render-identity change.
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const { session } = deps;

  useEffect(() => {
    const { mountedRef } = depsRef.current;
    mountedRef.current = true;
    const handle = connectSocket({
      onBatch: (batch) => session.onBatch(batch),
      onSeq: (frame) => session.onSeq(frame),
      onStatus: (up) => { void session.onSocketStatus(up); },
    });

    return () => {
      mountedRef.current = false;
      handle.close();
      // React StrictMode immediately replays effects in development while
      // preserving memoized resources. Defer terminal ownership cleanup one
      // microtask so the replayed setup can keep the session alive; a real
      // unmount leaves mountedRef false and performs cleanup exactly once.
      queueMicrotask(() => {
        if (mountedRef.current) return;
        session.dispose();
        depsRef.current.disposeOwned();
      });
    };
  }, [session]);
}
