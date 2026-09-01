// pattern: Imperative Shell
// SyncProvider's connect/reconnect lifecycle, extracted from the one mount
// effect that used to hold all of it. Four phases, in the order they run:
//   1. mount-time pending bootstrap — leftovers from a previous page load (a
//      reload can kill an in-flight POST), read before the first connect can
//      start draining them;
//   2. the reconnect protocol (reconnectFlow.ts), including the drain observer
//      the queue was constructed with;
//   3. socket status — the queue's connectivity is driven synchronously here,
//      never from a status effect, which would race child refetch effects;
//   4. StrictMode-safe teardown — terminal ownership cleanup deferred one
//      microtask so React's development effect replay can keep the memoized
//      queue/replica alive.
import { useEffect, useRef, type MutableRefObject } from "react";
import { createReconnectFlow } from "./reconnectFlow";
import type { DrainOutcome, OpQueue } from "./opQueue";
import type { ReplicaSync } from "./replicaSync";
import { connectSocket, type WsBatch, type WsSeq } from "./socket";
import type { SyncStatus } from "./syncState";

export interface SocketLifecycleDeps {
  /** Both mount-stable useMemo values: this lifecycle runs once per mount. */
  queue: OpQueue;
  replicaSync: ReplicaSync | null;
  /** Durable rows a previous page load left behind; started once per mount. */
  readInitialPending: () => Promise<number>;
  /** The startup poison gate: a first connect waits for it before flushing. */
  startupRun: () => Promise<void>;
  /** False after unmount (owned by the provider, which also guards on it). */
  mountedRef: MutableRefObject<boolean>;
  /** Written synchronously on every transition: the offline gateway and the
   * replica-state callback must not lag a transition by a React render. */
  statusRef: MutableRefObject<SyncStatus>;
  /** The indirection the queue was constructed with, so drains completing out
   * of band reach this mount's reconnect flow (and nothing after unmount). */
  drainObserverRef: MutableRefObject<(outcome: DrainOutcome) => void>;
  onBatch: (batch: WsBatch) => void;
  onSeq: (frame: WsSeq) => void;
  onStatus: (status: SyncStatus) => void;
  onResync: () => void;
  /** Terminal ownership cleanup the provider owns (the worker-backed replica
   * it created); runs after the queue and replica sync have been shut down. */
  disposeOwned: () => void;
}

export function useSocketLifecycle(deps: SocketLifecycleDeps): void {
  // Read through a ref so the effect below depends only on the two
  // mount-stable values and never re-runs on a render-identity change.
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const everConnectedRef = useRef(false);
  const { queue, replicaSync } = deps;

  useEffect(() => {
    const { mountedRef, statusRef, drainObserverRef } = depsRef.current;
    mountedRef.current = true;
    const initialPending = depsRef.current.readInitialPending();
    const reconnect = createReconnectFlow({
      queue,
      replicaSync,
      isMounted: () => mountedRef.current,
      onResync: () => depsRef.current.onResync(),
    });
    drainObserverRef.current = (outcome) => reconnect.observeDrain(outcome);

    const handle = connectSocket({
      onBatch: (batch) => depsRef.current.onBatch(batch),
      onSeq: (frame) => depsRef.current.onSeq(frame),
      onStatus: (up) => {
        // Drive the queue's connectivity synchronously here: the pump must be
        // paused/resumed at the exact transition.
        queue.setOnline(up);
        statusRef.current = up ? "connected" : "reconnecting";
        if (up) {
          if (everConnectedRef.current) {
            void reconnect.begin();
          } else {
            // A first connect with a non-empty durable queue IS a reconnect
            // after a gap — the gap just spans page loads. Views have already
            // fetched server state that predates the flush, and the flushed
            // batches echo back under this tab's own clientId (filtered), so
            // only the resync bump can refresh them. `viewsAreStale` is what
            // says so: this session's mount-time catch-up may already have
            // absorbed the flush, leaving the reconnect's own cursor
            // comparison with nothing to report (pkm-5fak).
            void initialPending.then(async (n) => {
              await depsRef.current.startupRun();
              if (n > 0) await reconnect.begin({ viewsAreStale: true });
            });
          }
          everConnectedRef.current = true;
          if (mountedRef.current) depsRef.current.onStatus("connected");
        } else {
          if (mountedRef.current) depsRef.current.onStatus("reconnecting");
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
        // A stopped instance's in-flight pull may still finish, but must not
        // reschedule another backoff retry that outlives this component.
        replicaSync?.stop();
        queue.dispose();
        depsRef.current.disposeOwned();
      });
    };
    // queue and replicaSync are both mount-stable useMemo values; listing
    // them satisfies the dependency check without letting this connect/
    // reconnect effect re-run (they never change identity for this mount).
  }, [queue, replicaSync]);
}
