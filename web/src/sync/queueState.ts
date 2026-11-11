// pattern: Functional Core
// The op queue's connectivity + retry-backoff policy: when a drain is
// terminally blocked, when a retryable failure schedules an escalating retry,
// and how online/pause/resume/dispose transitions cancel or reset that retry.
// The queue shell owns the actual timers, promises, deliveries, and
// persistence; this module only decides.

export type QueueBlockReason = "offline" | "retryable" | "recovering" | "disposed";

/** Who may hold the recovery barrier. Each owner releases only its own claim,
 * so one repair finishing never lifts a barrier another still needs:
 *   startup   clientRuntime, from mount until poison discovery answers
 *   poison    a rejected durable batch, from the rejection (or a reload's
 *             retained mark intent) until its repair succeeds
 *   recovery  replicaSync's recovery lease, for the length of one run
 *   lane      a rejected lane entry, until the outline repair is
 *             stable */
export type BarrierOwner = "startup" | "poison" | "recovery" | "lane";

export interface QueueState {
  online: boolean;
  /** The barrier's holders; delivery is blocked while any remain. */
  holders: ReadonlySet<BarrierOwner>;
  disposed: boolean;
  /** A backoff retry timer is currently armed (mirrors retryTimer !== null). */
  retryScheduled: boolean;
  /** Index into RETRY_DELAYS for the next scheduled retry. */
  retryIndex: number;
}

export const RETRY_DELAYS = [250, 1_000, 5_000] as const;

/** `holders` starts with "poison" when durable poison-mark intents survived a
 * reload (the shell must repair before delivery resumes). */
export function createQueueState(
  holders: Iterable<BarrierOwner> = [],
): QueueState {
  return {
    online: true,
    holders: new Set(holders),
    disposed: false,
    retryScheduled: false,
    retryIndex: 0,
  };
}

export type QueueEvent =
  | { type: "set-online"; online: boolean }
  | { type: "pause"; owner: BarrierOwner }
  | { type: "resume"; owner: BarrierOwner }
  | { type: "dispose" }
  | { type: "batch-succeeded" }
  | { type: "delivery-failed" }
  | { type: "retry-fired" };

export type QueueEffect =
  | { type: "clear-timer" }
  | { type: "start-timer"; delayMs: number }
  | { type: "kick" };

export interface QueueTransition {
  state: QueueState;
  effects: readonly QueueEffect[];
  /** Only for "delivery-failed": how the drain attempt is classified. */
  blockedReason?: QueueBlockReason;
}

/** Terminal reason a drain is blocked, or null when delivery may proceed.
 * Used at every post-batch short-circuit as well as failure classification. */
export function terminalReason(
  state: QueueState,
): "offline" | "recovering" | "disposed" | null {
  return state.disposed ? "disposed"
    : state.holders.size > 0 ? "recovering"
      : !state.online ? "offline" : null;
}

export function transitionQueue(
  state: QueueState,
  event: QueueEvent,
): QueueTransition {
  switch (event.type) {
    case "set-online":
      // cancelRetry(reset=true): clear the timer and reset the backoff index.
      return {
        state: { ...state, online: event.online, retryScheduled: false, retryIndex: 0 },
        effects: event.online
          ? [{ type: "clear-timer" }, { type: "kick" }]
          : [{ type: "clear-timer" }],
      };
    case "pause":
      // Recovery barrier: cancelRetry(reset=false) keeps the backoff index.
      return {
        state: {
          ...state, holders: new Set([...state.holders, event.owner]),
          retryScheduled: false,
        },
        effects: [{ type: "clear-timer" }],
      };
    case "resume": {
      if (!state.holders.has(event.owner)) return { state, effects: [] };
      const holders = new Set(state.holders);
      holders.delete(event.owner);
      return {
        state: { ...state, holders },
        effects: holders.size === 0 ? [{ type: "kick" }] : [],
      };
    }
    case "dispose":
      if (state.disposed) return { state, effects: [] };
      return {
        state: { ...state, disposed: true, online: false, retryScheduled: false },
        effects: [{ type: "clear-timer" }],
      };
    case "batch-succeeded":
      // cancelRetry(reset=true) after a delivered batch.
      return {
        state: { ...state, retryScheduled: false, retryIndex: 0 },
        effects: [{ type: "clear-timer" }],
      };
    case "delivery-failed": {
      const reason = terminalReason(state);
      if (reason !== null) return { state, effects: [], blockedReason: reason };
      // A retry already armed stays retryable without arming a second timer.
      if (state.retryScheduled) {
        return { state, effects: [], blockedReason: "retryable" };
      }
      const delayMs = RETRY_DELAYS[Math.min(state.retryIndex, RETRY_DELAYS.length - 1)];
      return {
        state: {
          ...state,
          retryScheduled: true,
          retryIndex: Math.min(state.retryIndex + 1, RETRY_DELAYS.length - 1),
        },
        effects: [{ type: "start-timer", delayMs }],
        blockedReason: "retryable",
      };
    }
    case "retry-fired":
      return { state: { ...state, retryScheduled: false }, effects: [] };
    default: {
      const exhaustive: never = event;
      throw new Error(`unhandled queue event: ${String(exhaustive)}`);
    }
  }
}
