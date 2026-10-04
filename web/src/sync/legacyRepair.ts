// pattern: Imperative Shell
// The legacy outline repair, without React. A batch from the queue's
// in-memory lane that the server rejects pauses delivery and fires onDesync;
// this repair forces every active outline through an authoritative read and
// only then resumes delivery. SyncProvider creates one per mount; the sync
// property harness drives the same module over its own transport.
//
// It mirrors the client runtime's poison repair (clientRuntime.ts): a run is
// single-flight, and a reconnect reruns one whose last attempt failed, since
// a failed authoritative read is most often the network going away and
// nothing else retries it. Without that retry every later edit waits behind
// the paused queue for a click on Retry or a reload.
import type { SyncEvent } from "./syncState";

export interface LegacyRepairDeps {
  /** repairActiveOutlineSessions in the app: calls onStable once delivery
   * may resume, and rejects when the repair failed. */
  repairSessions: (onStable: () => void) => Promise<void>;
  /** The legacy-repair-* sync events; SyncProvider passes applySync. */
  onEvent: (event: SyncEvent) => void;
  /** Releases the queue's recovery pause. */
  resume: () => void;
  /** False after unmount: nothing is reported, resumed or retried past it. */
  isMounted: () => boolean;
}

export interface LegacyRepair {
  /** Repair after this rejection; joins a repair already running, which
   * then reports under the newer error. */
  run(error: unknown): Promise<void>;
  /** A socket reconnect: rerun a repair whose last attempt failed, exactly
   * as the banner's Retry does; otherwise nothing. A repair still running is
   * awaited first and retried once if it fails. */
  retryFailed(): Promise<void>;
  /** The last rejection a run recorded: what the banner's Retry reruns. */
  rejected(): unknown;
  /** Forget the recorded rejection (a dismissed repaired problem). */
  clear(): void;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createLegacyRepair(deps: LegacyRepairDeps): LegacyRepair {
  const emit = (event: SyncEvent): void => {
    if (deps.isMounted()) deps.onEvent(event);
  };
  let rejectedError: unknown;
  let repairRun: Promise<void> | null = null;
  // The last attempt failed and no run has started since.
  let repairFailed = false;

  const run = (error: unknown): Promise<void> => {
    rejectedError = error;
    if (repairRun) return repairRun;
    repairFailed = false;
    const message = messageOf(error);
    emit({ type: "legacy-repair-started", error: message });
    const attempt = deps.repairSessions(() => {
        if (!deps.isMounted()) return;
        emit({ type: "legacy-repair-succeeded", error: message });
        deps.resume();
      })
      .catch((repairError: unknown) => {
        repairFailed = true;
        emit({
          type: "legacy-repair-failed", error: message,
          repairError: messageOf(repairError),
        });
      });
    repairRun = attempt.finally(() => { repairRun = null; });
    return repairRun;
  };

  return {
    run,
    retryFailed: async () => {
      // As the runtime's retryFailedRepair: a connect that arrives mid-repair
      // waits for it, and a rerun clears the flag as it starts, so of several
      // connects waiting on one failed attempt only the first retries it.
      await (repairRun ?? Promise.resolve());
      if (!deps.isMounted() || !repairFailed) return;
      await run(rejectedError);
    },
    rejected: () => rejectedError,
    clear: () => { rejectedError = undefined; },
  };
}
