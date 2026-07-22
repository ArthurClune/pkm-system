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
import { attachActiveOutlineWriteReplay, repairActiveOutlineSessions,
         trackActiveOutlineWrite } from "../outline/outlineSessions";
import type { OutlineReplayAction } from "../outline/outlineState";
import { createReplica, type Replica } from "../replica/client";
import { toPortLike } from "../replica/rpc";
import { clientId, createOpQueue, type DrainOutcome,
         type PoisonEvent, type WriteTicket } from "./opQueue";
import { createReplicaSync, ResetBlockedError, type ReplicaState } from "./replicaSync";
import { connectSocket, type WsBatch } from "./socket";
import { computeEditability, transitionSync,
         type SyncEvent, type SyncStatus, type SyncProblem } from "./syncState";

export type { SyncStatus, SyncProblem } from "./syncState";

const mergePoisonEvents = (
  ...groups: ReadonlyArray<readonly PoisonEvent[]>
): PoisonEvent[] => {
  const merged = new Map<string, PoisonEvent>();
  groups.flat().forEach((event) => {
    merged.set(`${event.rowId}\u0000${event.batchId}`, event);
  });
  return [...merged.values()].sort((a, b) =>
    a.rowId - b.rowId || a.batchId.localeCompare(b.batchId));
};

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

export const SyncContext = createContext<Sync>({
  status: "connecting",
  resyncSeq: 0,
  replicaMode: "starting",
  canEdit: false,
  pending: 0,
  retryProblem: () => Promise.resolve(),
  dismissProblem: () => undefined,
  resetReplica: () => Promise.resolve(),
  enqueue: () => {
    // a silent default would drop writes without a trace
    throw new Error("enqueue called outside <SyncProvider>");
  },
  attachOutlineReplay: () => undefined,
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
  const startupDiscoveringPoisonRef = useRef(true);
  const legacyRepairRunRef = useRef<Promise<void> | null>(null);
  const legacyRejectedRef = useRef<unknown>();
  const repairLegacyRef = useRef<(error: unknown) => Promise<void>>(
    async () => undefined,
  );
  const continueStartupRef = useRef<(
    marked: readonly PoisonEvent[],
  ) => Promise<void>>(async () => undefined);
  const problemRef = useRef<SyncProblem>();
  problemRef.current = problem;

  // Route the deterministic delivery-health policy through the syncState core:
  // it computes the next problem value and any resync intent; this shell keeps
  // the mounted guard, the async orchestration, and the queue/replica I/O. The
  // current problem is read from problemRef (the last rendered value), matching
  // the former inline setProblem call sites.
  const applySync = (event: SyncEvent): void => {
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
      if (effect.type === "bump-resync") setResyncSeq((n) => n + 1);
    }
  };

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
    () => createOpQueue(replicaRef.current ?? null, (error) => {
      void repairLegacyRef.current(error);
    }, (outcome) => drainObserverRef.current(outcome)), []);

  repairLegacyRef.current = (error) => {
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
  };

  useEffect(() => {
    const offs = [
      queue.onPending((n) => { if (mountedRef.current) setPending(n); }),
      queue.onQuota(() => {
        if (mountedRef.current) setQuotaExhausted(true);
      }),
      queue.onPoisonMarkFailed(({ event, error }) => {
        repairTargetsRef.current = [event];
        repairSucceededRef.current = false;
        applySync({
          type: "poison-mark-failed", event,
          error: error instanceof Error ? error.message : String(error),
        });
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
    // queue is a mount-stable useMemo value; listing it keeps this memo
    // honest without changing that replicaSync is created exactly once.
  }, [queue]);

  const repairEventsRef = useRef<(events: readonly PoisonEvent[]) => Promise<void>>(
    async () => undefined);
  repairEventsRef.current = (events) => {
    if (events.length === 0) return Promise.resolve();
    if (repairRunRef.current) {
      repairTargetsRef.current = mergePoisonEvents(
        repairTargetsRef.current, events,
      );
      return repairRunRef.current;
    }
    repairTargetsRef.current = mergePoisonEvents(events);
    repairSucceededRef.current = false;
    const event = repairTargetsRef.current[0];
    applySync({ type: "repair-started", event });
    const run = (async () => {
      try {
        await replicaSync!.rebaseAuthoritative("poison");
        let remaining = 0;
        for (const poisonEvent of repairTargetsRef.current) {
          const result = await replicaRef.current!.deleteBatch(poisonEvent.rowId);
          remaining = result.pending;
        }
        if (mountedRef.current) {
          setPending(remaining);
          applySync({ type: "repair-succeeded", event });
        }
        replicaSync!.completeAuthoritativeRepair("poison");
        if (mountedRef.current) {
          queue.resume("recovery");
        }
        repairSucceededRef.current = true;
      } catch (error: unknown) {
        applySync({
          type: "repair-failed", event,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    repairRunRef.current = run.finally(() => { repairRunRef.current = null; });
    return repairRunRef.current;
  };

  continueStartupRef.current = async (marked) => {
    let discovered: PoisonEvent[] = [];
    try {
      discovered = await replicaRef.current!.poisonedBatches();
    } catch (error: unknown) {
      if (marked.length === 0) {
        applySync({
          type: "poison-discovery-failed",
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // Returned mark evidence is sufficient to repair those rows safely;
      // never discard it merely because the broader discovery read failed.
    }
    const repairable = mergePoisonEvents(marked, discovered);
    startupDiscoveringPoisonRef.current = false;
    if (repairable.length > 0) {
      await repairEventsRef.current(repairable);
      if (!repairSucceededRef.current) return;
    } else {
      applySync({ type: "poison-discovery-cleared" });
      queue.resume("recovery");
    }
    await replicaSync!.start();
  };

  useEffect(() => {
    if (replicaSync === null) {
      setReplicaState({ mode: "no-replica" });
      return;
    }
    // Close the reload window where later durable work could post before a
    // previously rejected optimistic batch is repaired.
    queue.setOnline(false);
    queue.pause("recovery");
    startupRunRef.current = (async () => {
      let marked: readonly PoisonEvent[];
      try {
        // Reload fallback intents are marked before any database discovery,
        // initialization, or delivery. This path never calls /api/ops.
        marked = await queue.retryPoisonMarks();
      } catch {
        // The typed failure listener owns the visible Retry state; retain the
        // startup gate and recovery barrier until marking succeeds.
        return;
      }
      await continueStartupRef.current(marked);
    })().catch(() => undefined);
  }, [queue, replicaSync]);

  useEffect(() => queue.onPoison((event) => {
    // Startup mark-only retries are followed by one authoritative database
    // discovery so multiple retained intents and pre-existing poison rows
    // enter the same repair. Current-session poison starts repair directly.
    if (startupDiscoveringPoisonRef.current) return;
    void repairEventsRef.current([event]);
  }), [queue]);

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
        // A stopped instance's in-flight pull may still finish, but must not
        // reschedule another backoff retry that outlives this component.
        replicaSync?.stop();
        queue.dispose();
        const owned = ownedReplicaRef.current;
        ownedReplicaRef.current = null;
        if (owned) void owned.replica.dispose();
      });
    };
    // queue and replicaSync are both mount-stable useMemo values; listing
    // them satisfies the dependency check without letting this connect/
    // reconnect effect re-run (they never change identity for this mount).
  }, [queue, replicaSync]);

  // Connected: editing always allowed (server-authoritative, as before).
  // Offline: allowed only with a ready replica that can still persist —
  // quota exhaustion offline means an edit could be silently lost, so the
  // editor is frozen with a reason instead (spec section 6). The rule lives
  // in the syncState core.
  const { canEdit, readOnlyReason } =
    computeEditability(status, replicaState.mode, quotaExhausted);

  const api = useMemo<Sync>(() => ({
    status,
    resyncSeq,
    replicaMode: replicaState.mode,
    canEdit,
    pending,
    readOnlyReason,
    problem,
    retryProblem: () => {
      const currentProblem = problemRef.current;
      if (currentProblem?.kind === "legacy-rejected" &&
          currentProblem.repair === "failed") {
        return repairLegacyRef.current(legacyRejectedRef.current);
      }
      if (currentProblem?.kind === "rejected-batch" &&
          currentProblem.repair === "mark-failed") {
        const retryBlockedStartup = startupDiscoveringPoisonRef.current;
        return (async () => {
          try {
            const marked = await queue.retryPoisonMarks();
            if (retryBlockedStartup) {
              await continueStartupRef.current(marked);
              return;
            }
          } catch {
            return;
          }
          await (repairRunRef.current ?? Promise.resolve());
          if (repairSucceededRef.current) await replicaSync?.start();
        })();
      }
      if (currentProblem?.kind === "poison-discovery") {
        return continueStartupRef.current([]);
      }
      if (currentProblem?.kind !== "rejected-batch" ||
          currentProblem.repair !== "failed") return Promise.resolve();
      return repairEventsRef.current(repairTargetsRef.current).then(async () => {
        if (repairSucceededRef.current) await replicaSync?.start();
      });
    },
    dismissProblem: () => {
      const currentProblem = problemRef.current;
      if (currentProblem?.kind === "legacy-rejected" &&
          currentProblem.repair === "repaired") {
        legacyRejectedRef.current = undefined;
      } else if (currentProblem?.kind === "rejected-batch" &&
          currentProblem.repair === "repaired") {
        repairTargetsRef.current = [];
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
  }), [status, resyncSeq, replicaState, canEdit, pending, readOnlyReason,
       problem, queue, replicaSync]);

  return <SyncContext.Provider value={api}>{children}</SyncContext.Provider>;
}
