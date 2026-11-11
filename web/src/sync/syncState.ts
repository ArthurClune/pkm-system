// pattern: Functional Core
// The deterministic sync policy: whether editing is allowed (and why not),
// whether a replica turning ready while the socket is down must force a
// resync, and the delivery-health "problem" lifecycle (rejected-batch repair
// phases, outline repair, poison discovery, replica stalls). The sync session
// (session.ts) owns the I/O — the queue, the replica, async single-flight and
// liveness — and folds events here, then reports the returned problem and
// executes the effects.
import type { PoisonEvent } from "./opQueue";
import type { ReplicaState } from "./replicaSync";

export type SyncStatus = "connecting" | "connected" | "reconnecting";
export type ReplicaMode = ReplicaState["mode"];

export type SyncProblem =
  | { kind: "rejected-batch"; event: PoisonEvent;
      repair: "mark-failed" | "running" | "failed" | "repaired";
      error?: string }
  | { kind: "poison-discovery"; error: string }
  /** The replica could not be opened, so this session runs online-only: edits
   * still reach the server, but there is no local cache and no offline
   * editing. Session-scoped by design (the worker latches a failed open), so
   * the only way out is a reload. */
  | { kind: "replica-unusable"; error: string }
  | { kind: "outline-rejected"; repair: "running" | "failed" | "repaired";
      error: string; repairError?: string }
  | { kind: "replica-stalled"; error: string;
      reset: "idle" | "running" | "blocked" | "failed";
      pending?: number; resetError?: string };

type OutlineProblem = Extract<SyncProblem, { kind: "outline-rejected" }>;

export interface SyncState {
  problem: SyncProblem | undefined;
  /** A outline repair's problem held back while a rejected durable batch's
   * outranks it (see outline). It is shown once that problem ends. */
  outlineBehind?: OutlineProblem;
}

export type SyncEvent =
  /** Every replica mode report, with the mode it replaces and the socket
   * status at the moment of the report. */
  | { type: "replica-state"; prev: ReplicaMode; state: ReplicaState;
      status: SyncStatus }
  | { type: "poison-mark-failed"; event: PoisonEvent; error: string }
  | { type: "repair-started"; event: PoisonEvent }
  | { type: "repair-succeeded"; event: PoisonEvent }
  | { type: "repair-failed"; event: PoisonEvent; error: string }
  | { type: "poison-discovery-failed"; error: string }
  | { type: "poison-intents-discarded" }
  | { type: "replica-unusable"; error: string }
  | { type: "poison-discovery-cleared" }
  | { type: "outline-repair-started"; error: string }
  | { type: "outline-repair-succeeded"; error: string }
  | { type: "outline-repair-failed"; error: string; repairError: string }
  | { type: "reset-started" }
  | { type: "reset-blocked"; pending: number }
  | { type: "reset-failed"; error: string }
  | { type: "reset-succeeded" }
  | { type: "dismiss" }
  /** Either delivery path's ack named a skipped op: the active view may be
   * stale (a replica-backed tab's own feed tombstones the row, but nothing
   * else bumps resync for it) and must refetch, same as any other resync
   * bump. Never a "problem" -- the server committed the batch fine. */
  | { type: "ops-skipped" };

export type SyncEffect = { type: "bump-resync" };

export interface SyncTransition {
  state: SyncState;
  effects: readonly SyncEffect[];
}

/** Editing is always allowed when connected (server-authoritative). Offline it
 * is allowed only with a ready replica.
 *
 * A third input, `quotaExhausted`, used to freeze the editor offline once local
 * storage was full, on the reasoning that a further edit could be silently
 * lost. It was unreachable: the flag behind it could never be set, because the
 * opfs-sahpool VFS reports an exhausted disk as an undifferentiated
 * SQLITE_IOERR. An exhausted disk now behaves like every other
 * failure to persist locally — the op is retained in the fallback lane and
 * delivered when the socket allows. */
export function computeEditability(
  status: SyncStatus,
  replicaMode: ReplicaMode,
): { canEdit: boolean; readOnlyReason?: string } {
  const canEdit = status === "connected" || replicaMode === "ready";
  if (canEdit) return { canEdit: true, readOnlyReason: undefined };
  const readOnlyReason = replicaMode === "recovery-failed"
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

type StalledProblem = Extract<SyncProblem, { kind: "replica-stalled" }>;

/** A rejected durable batch not yet repaired, or a discovery that could not
 * say whether there is one. Its banner carries the Retry that lifts the
 * poison owner's barrier, so a outline repair's banner waits behind it rather
 * than taking that Retry away. */
const poisonUnresolved = (current: SyncProblem | undefined): boolean =>
  (current?.kind === "rejected-batch" && current.repair !== "repaired")
  || current?.kind === "poison-discovery";

/** Show a poison-side problem, keeping an unrepaired outline one it replaces
 * behind it. */
const poisonProblem = (
  state: SyncState, next: SyncProblem,
): SyncTransition => {
  const current = state.problem;
  const behind = current?.kind === "outline-rejected" && current.repair !== "repaired"
    ? current : state.outlineBehind;
  return {
    state: { problem: next, ...(behind ? { outlineBehind: behind } : {}) },
    effects: [],
  };
};

/** The poison-side problem ended: a outline problem held behind it, if any,
 * takes its place, else `next`. */
const poisonEnded = (
  state: SyncState, next: SyncProblem | undefined,
  effects: readonly SyncEffect[] = [],
): SyncTransition => {
  const behind = state.outlineBehind;
  const shown = behind !== undefined && (next === undefined || behind.repair !== "repaired")
    ? behind : next;
  return { state: { problem: shown }, effects };
};

/** A outline repair's phase: shown, or held behind an unresolved poison
 * problem. Its effects apply either way. */
const outline = (
  state: SyncState, next: OutlineProblem, effects: readonly SyncEffect[] = [],
): SyncTransition => poisonUnresolved(state.problem)
  ? { state: { ...state, outlineBehind: next }, effects }
  : { state: { problem: next }, effects };

/** Shared by reset-started/reset-blocked/reset-failed: a delivery problem of
 * a different kind takes precedence over a reset event, so those cases must
 * leave the state untouched (undefined signals that). Otherwise returns the
 * replica-stalled problem to update in place, creating a fresh idle one if
 * none exists yet — the reset events can arrive before any stalled mode
 * report has, e.g. in tests that drive reset-started directly. */
function stalledBaseOrDeferred(state: SyncState): StalledProblem | undefined {
  const current = state.problem;
  if (current && current.kind !== "replica-stalled") return undefined;
  return current?.kind === "replica-stalled"
    ? current : { kind: "replica-stalled", error: "", reset: "idle" };
}

const unchanged = (state: SyncState): SyncTransition => ({ state, effects: [] });

function replicaUnusable(state: SyncState, error: string): SyncTransition {
  // A background "this session is online-only" report must not stomp a
  // delivery problem the user can act on — overwriting a failed
  // outline-rejected repair would take its Retry with it, and retryProblem
  // would no longer reach that repair at all. Same precedence shape as
  // replicaStalled below.
  const current = state.problem;
  if (current && current.kind !== "replica-unusable") return unchanged(state);
  return problem(state, { kind: "replica-unusable", error });
}

function replicaStalled(state: SyncState, error: string): SyncTransition {
  const current = state.problem;
  // Delivery problems (a different kind) take precedence over a
  // background replica-stalled report — leave the state untouched.
  if (current && current.kind !== "replica-stalled") return unchanged(state);
  // A re-report (the engine re-emits stalled on every retry) must not stomp
  // an in-flight reset the user is already watching.
  return problem(state, current?.kind === "replica-stalled"
    ? { ...current, error }
    : { kind: "replica-stalled", error, reset: "idle" });
}

function replicaUnstalled(state: SyncState): SyncTransition {
  const current = state.problem;
  return current?.kind === "replica-stalled" && current.reset !== "running"
    ? problem(state, undefined) : unchanged(state);
}

/** The banner a mode report raises or clears. A wedged replica and a failed
 * recovery while the socket is up both need the stalled banner and its reset;
 * a failed recovery offline keeps its read-only reason instead
 * (computeEditability). */
function bannerForMode(state: SyncState, next: ReplicaState,
                       status: SyncStatus): SyncTransition {
  switch (next.mode) {
    case "stalled":
      return replicaStalled(state, next.error);
    case "ready":
      return replicaUnstalled(state);
    case "recovery-failed":
      return status === "connected"
        ? replicaStalled(state, next.error) : unchanged(state);
    case "no-replica":
      // A worker that died mid-session: the same online-only banner and
      // Reload as a replica that never opened.
      return next.error === undefined
        ? unchanged(state) : replicaUnusable(state, next.error);
    case "starting":
      return unchanged(state);
  }
}

export function transitionSync(state: SyncState, event: SyncEvent): SyncTransition {
  switch (event.type) {
    case "replica-state": {
      const banner = bannerForMode(state, event.state, event.status);
      // Views that fetched while the replica was still starting only refetch
      // through the shim once a resync bump fires; force one when the replica
      // turns ready but the socket has not (re)connected.
      const turnedReadyOffline = event.prev !== "ready"
        && event.state.mode === "ready" && event.status !== "connected";
      return turnedReadyOffline
        ? { state: banner.state,
            effects: [...banner.effects, { type: "bump-resync" }] }
        : banner;
    }
    case "poison-mark-failed":
      return poisonProblem(state, {
        kind: "rejected-batch", event: event.event, repair: "mark-failed",
        error: event.error,
      });
    case "repair-started":
      return poisonProblem(state, {
        kind: "rejected-batch", event: event.event, repair: "running",
      });
    case "repair-succeeded":
      return poisonEnded(state, {
        kind: "rejected-batch", event: event.event, repair: "repaired",
      }, [{ type: "bump-resync" }]);
    case "repair-failed":
      return poisonProblem(state, {
        kind: "rejected-batch", event: event.event, repair: "failed",
        error: event.error,
      });
    case "poison-discovery-failed":
      return poisonProblem(state, { kind: "poison-discovery", error: event.error });
    case "poison-intents-discarded":
      // The user discarded retained poison-mark intents, so the
      // mark-failed problem reporting them is now stale. Only that exact
      // phase clears — replica-unusable never stomps another kind (below),
      // so a leftover mark-failed banner would otherwise outlive its intents.
      return state.problem?.kind === "rejected-batch"
          && state.problem.repair === "mark-failed"
        ? poisonEnded(state, undefined) : { state, effects: [] };
    case "replica-unusable":
      return replicaUnusable(state, event.error);
    case "poison-discovery-cleared":
      return state.problem?.kind === "poison-discovery"
        ? poisonEnded(state, undefined) : { state, effects: [] };
    case "outline-repair-started":
      return outline(state, {
        kind: "outline-rejected", repair: "running", error: event.error,
      });
    case "outline-repair-succeeded":
      return outline(state, {
        kind: "outline-rejected", repair: "repaired", error: event.error,
      }, [{ type: "bump-resync" }]);
    case "outline-repair-failed":
      return outline(state, {
        kind: "outline-rejected", repair: "failed", error: event.error,
        repairError: event.repairError,
      });
    case "reset-started": {
      const base = stalledBaseOrDeferred(state);
      if (!base) return { state, effects: [] };
      return problem(state, {
        ...base, reset: "running", pending: undefined, resetError: undefined,
      });
    }
    case "reset-blocked": {
      const base = stalledBaseOrDeferred(state);
      if (!base) return { state, effects: [] };
      return problem(state, {
        ...base, reset: "blocked", pending: event.pending, resetError: undefined,
      });
    }
    case "reset-failed": {
      const base = stalledBaseOrDeferred(state);
      if (!base) return { state, effects: [] };
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
      const repaired = (current?.kind === "outline-rejected"
        || current?.kind === "rejected-batch") && current.repair === "repaired";
      // A stalled replica's idle/running states are the only signal a user
      // has that local data is broken — only an acknowledged blocked/failed
      // reset outcome may be dismissed. A later re-report re-raises the
      // banner as a fresh idle problem (see replicaStalled).
      const acknowledgedReset = current?.kind === "replica-stalled"
        && (current.reset === "blocked" || current.reset === "failed");
      return repaired || acknowledgedReset
        ? problem(state, undefined) : { state, effects: [] };
    }
    case "ops-skipped":
      return { state, effects: [{ type: "bump-resync" }] };
    default: {
      const exhaustive: never = event;
      throw new Error(`unhandled sync event: ${String(exhaustive)}`);
    }
  }
}
