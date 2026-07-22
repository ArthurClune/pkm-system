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
      error: string; repairError?: string }
  | { kind: "replica-stalled"; error: string;
      reset: "idle" | "running" | "blocked" | "failed";
      pending?: number; resetError?: string };

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
  | { type: "replica-stalled"; error: string }
  | { type: "replica-unstalled" }
  | { type: "reset-started" }
  | { type: "reset-blocked"; pending: number }
  | { type: "reset-failed"; error: string }
  | { type: "reset-succeeded" }
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
      : replicaMode === "stalled"
        ? "local data is stale — reset local data to recover"
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
    case "replica-stalled": {
      const current = state.problem;
      // Delivery problems (a different kind) take precedence over a
      // background replica-stalled report — leave the state untouched.
      if (current && current.kind !== "replica-stalled") return { state, effects: [] };
      // A re-report (Task 6's engine re-emits stalled on every retry) must
      // not stomp an in-flight reset the user is already watching.
      return problem(state, current?.kind === "replica-stalled"
        ? { ...current, error: event.error }
        : { kind: "replica-stalled", error: event.error, reset: "idle" });
    }
    case "replica-unstalled": {
      const current = state.problem;
      return current?.kind === "replica-stalled" && current.reset !== "running"
        ? problem(state, undefined) : { state, effects: [] };
    }
    case "reset-started": {
      const current = state.problem;
      // Delivery problems (a different kind) take precedence — leave the state untouched.
      if (current && current.kind !== "replica-stalled") return { state, effects: [] };
      // Create or update the replica-stalled problem to move reset to running.
      const base = current?.kind === "replica-stalled"
        ? current : { kind: "replica-stalled" as const, error: "", reset: "idle" as const };
      return problem(state, {
        ...base, reset: "running", pending: undefined, resetError: undefined,
      });
    }
    case "reset-blocked": {
      const current = state.problem;
      // Delivery problems (a different kind) take precedence — leave the state untouched.
      if (current && current.kind !== "replica-stalled") return { state, effects: [] };
      // Create or update the replica-stalled problem to move reset to blocked.
      const base = current?.kind === "replica-stalled"
        ? current : { kind: "replica-stalled" as const, error: "", reset: "idle" as const };
      return problem(state, {
        ...base, reset: "blocked", pending: event.pending, resetError: undefined,
      });
    }
    case "reset-failed": {
      const current = state.problem;
      // Delivery problems (a different kind) take precedence — leave the state untouched.
      if (current && current.kind !== "replica-stalled") return { state, effects: [] };
      // Create or update the replica-stalled problem to move reset to failed.
      const base = current?.kind === "replica-stalled"
        ? current : { kind: "replica-stalled" as const, error: "", reset: "idle" as const };
      return problem(state, {
        ...base, reset: "failed", resetError: event.error, pending: undefined,
      });
    }
    case "reset-succeeded": {
      const current = state.problem;
      return current?.kind === "replica-stalled"
        ? problem(state, undefined, [{ type: "bump-resync" }])
        : { state, effects: [{ type: "bump-resync" }] };
    }
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
