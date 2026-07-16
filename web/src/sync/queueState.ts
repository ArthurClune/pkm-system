// pattern: Functional Core
// The op queue's connectivity + retry-backoff policy. Both the replica-backed
// and legacy in-memory queues embed the identical rules for when a drain is
// terminally blocked, when a retryable failure schedules an escalating retry,
// and how online/pause/resume/dispose transitions cancel or reset that retry.
// The shells own the actual timers, promises, deliveries, and persistence;
// this module only decides. Behaviour matches the former inline flag mutations
// exactly (Task 1-3 semantics).

export type QueueBlockReason = "offline" | "retryable" | "recovering" | "disposed";

export interface QueueState {
  online: boolean;
  recovering: boolean;
  disposed: boolean;
  /** A backoff retry timer is currently armed (mirrors retryTimer !== null). */
  retryScheduled: boolean;
  /** Index into RETRY_DELAYS for the next scheduled retry. */
  retryIndex: number;
}

export const RETRY_DELAYS = [250, 1_000, 5_000] as const;

/** `recovering` starts true when durable poison-mark intents survived a reload
 * (the shell must repair before delivery resumes). */
export function createQueueState(recovering = false): QueueState {
  return {
    online: true,
    recovering,
    disposed: false,
    retryScheduled: false,
    retryIndex: 0,
  };
}

export type QueueEvent =
  | { type: "set-online"; online: boolean }
  | { type: "pause" }
  | { type: "resume" }
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
    : state.recovering ? "recovering"
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
        state: { ...state, recovering: true, retryScheduled: false },
        effects: [{ type: "clear-timer" }],
      };
    case "resume":
      if (!state.recovering) return { state, effects: [] };
      return { state: { ...state, recovering: false }, effects: [{ type: "kick" }] };
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
