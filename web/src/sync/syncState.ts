// pattern: Functional Core
// The deterministic sync policy SyncProvider used to hold inline: whether
// editing is allowed (and why not), whether a replica turning ready while the
// socket is down must force a resync, and the delivery-health "problem"
// lifecycle (rejected-batch repair phases, legacy repair, poison discovery).
// The provider still owns all I/O — sockets, the queue, the replica, React
// state, async single-flight, and mounted guards — and dispatches events here,
// then executes the returned problem value and effects. Behaviour is unchanged
// (Task 2/3/5 semantics).
import type { PoisonEvent } from "./opQueue";
import type { ReplicaState } from "./replicaSync";

export type SyncStatus = "connecting" | "connected" | "reconnecting";
export type ReplicaMode = ReplicaState["mode"];

export type SyncProblem =
  | { kind: "rejected-batch"; event: PoisonEvent;
      repair: "mark-failed" | "running" | "failed" | "repaired";
      error?: string }
  | { kind: "poison-discovery"; error: string }
  | { kind: "legacy-rejected"; repair: "running" | "failed" | "repaired";
      error: string; repairError?: string };

export interface SyncState {
  problem: SyncProblem | undefined;
}

export function createSyncState(): SyncState {
  return { problem: undefined };
}

export type SyncEvent =
  | { type: "mode-ready-check"; prevMode: ReplicaMode; mode: ReplicaMode;
      status: SyncStatus }
  | { type: "poison-mark-failed"; event: PoisonEvent; error: string }
  | { type: "repair-started"; event: PoisonEvent }
  | { type: "repair-succeeded"; event: PoisonEvent }
  | { type: "repair-failed"; event: PoisonEvent; error: string }
  | { type: "poison-discovery-failed"; error: string }
  | { type: "poison-discovery-cleared" }
  | { type: "legacy-repair-started"; error: string }
  | { type: "legacy-repair-succeeded"; error: string }
  | { type: "legacy-repair-failed"; error: string; repairError: string }
  | { type: "dismiss" };

export type SyncEffect = { type: "bump-resync" };

export interface SyncTransition {
  state: SyncState;
  effects: readonly SyncEffect[];
}

/** Editing is always allowed when connected (server-authoritative). Offline it
 * is allowed only with a ready replica that can still persist; quota exhaustion
 * offline freezes the editor so an edit cannot be silently lost. */
export function computeEditability(
  status: SyncStatus,
  replicaMode: ReplicaMode,
  quotaExhausted: boolean,
): { canEdit: boolean; readOnlyReason?: string } {
  const canEdit = status === "connected"
    || (replicaMode === "ready" && !quotaExhausted);
  if (canEdit) return { canEdit: true, readOnlyReason: undefined };
  const readOnlyReason = quotaExhausted
    ? "local storage is full — reconnect to sync"
    : replicaMode === "recovery-failed"
      ? "local data recovery failed — reconnect to continue"
      : "offline — this graph is not yet available locally";
  return { canEdit: false, readOnlyReason };
}

const problem = (
  state: SyncState,
  next: SyncProblem | undefined,
  effects: readonly SyncEffect[] = [],
): SyncTransition => ({ state: { ...state, problem: next }, effects });

export function transitionSync(state: SyncState, event: SyncEvent): SyncTransition {
  switch (event.type) {
    case "mode-ready-check":
      // Views that fetched while the replica was still starting only refetch
      // through the shim once a resync bump fires; force one when the replica
      // turns ready but the socket has not (re)connected.
      return {
        state,
        effects: event.prevMode !== "ready" && event.mode === "ready"
          && event.status !== "connected"
          ? [{ type: "bump-resync" }] : [],
      };
    case "poison-mark-failed":
      return problem(state, {
        kind: "rejected-batch", event: event.event, repair: "mark-failed",
        error: event.error,
      });
    case "repair-started":
      return problem(state, {
        kind: "rejected-batch", event: event.event, repair: "running",
      });
    case "repair-succeeded":
      return problem(state, {
        kind: "rejected-batch", event: event.event, repair: "repaired",
      }, [{ type: "bump-resync" }]);
    case "repair-failed":
      return problem(state, {
        kind: "rejected-batch", event: event.event, repair: "failed",
        error: event.error,
      });
    case "poison-discovery-failed":
      return problem(state, { kind: "poison-discovery", error: event.error });
    case "poison-discovery-cleared":
      return state.problem?.kind === "poison-discovery"
        ? problem(state, undefined) : { state, effects: [] };
    case "legacy-repair-started":
      return problem(state, {
        kind: "legacy-rejected", repair: "running", error: event.error,
      });
    case "legacy-repair-succeeded":
      return problem(state, {
        kind: "legacy-rejected", repair: "repaired", error: event.error,
      }, [{ type: "bump-resync" }]);
    case "legacy-repair-failed":
      return problem(state, {
        kind: "legacy-rejected", repair: "failed", error: event.error,
        repairError: event.repairError,
      });
    case "dismiss": {
      const current = state.problem;
      const repaired = (current?.kind === "legacy-rejected"
        || current?.kind === "rejected-batch") && current.repair === "repaired";
      return repaired ? problem(state, undefined) : { state, effects: [] };
    }
    default: {
      const exhaustive: never = event;
      throw new Error(`unhandled sync event: ${String(exhaustive)}`);
    }
  }
}
