// pattern: Imperative Shell
// The legacy outline repair, without React. The queue's onDesync starts it:
// a batch from the in-memory lane that the server rejected, which paused
// the barrier's "lane" owner, or a local refusal (a text limit, a
// replica-rejected op), which paused nothing. It forces every active outline
// through an authoritative read, then resumes "lane" if a lane rejection is
// owed it, and never otherwise. SyncProvider creates one per mount; the sync
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
  /** Releases the queue's "lane" barrier owner. */
  resume: () => void;
  /** False after unmount: nothing is reported, resumed or retried past it. */
  isMounted: () => boolean;
}

export interface LegacyRepair {
  /** Repair after this rejection. `lane` says the queue paused the "lane"
   * owner for it. Joins a repair still reading, which then reports under the
   * newer error; a repair already past its stable point read too early for
   * this one, so a fresh run follows it. */
  run(error: unknown, desync?: { lane: boolean }): Promise<void>;
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
  let repairRun: { stable: boolean; done: Promise<void> } | null = null;
  // The last attempt failed and no run has started since.
  let repairFailed = false;
  // A lane rejection paused the queue and no stable repair has resumed it
  // yet. Outlives a failed run, so the retry that succeeds resumes it.
  let laneOwed = false;

  const run = (error: unknown, desync?: { lane: boolean }): Promise<void> => {
    rejectedError = error;
    if (desync?.lane === true) laneOwed = true;
    if (repairRun?.stable === false) return repairRun.done;
    if (repairRun) {
      return repairRun.done.then(() => run(rejectedError));
    }
    repairFailed = false;
    const message = messageOf(error);
    emit({ type: "legacy-repair-started", error: message });
    const current = { stable: false, done: Promise.resolve() };
    const attempt = deps.repairSessions(() => {
        if (!deps.isMounted()) return;
        current.stable = true;
        emit({ type: "legacy-repair-succeeded", error: message });
        if (laneOwed) {
          laneOwed = false;
          deps.resume();
        }
      })
      .catch((repairError: unknown) => {
        repairFailed = true;
        emit({
          type: "legacy-repair-failed", error: message,
          repairError: messageOf(repairError),
        });
      });
    current.done = attempt.finally(() => { repairRun = null; });
    repairRun = current;
    return current.done;
  };

  return {
    run,
    retryFailed: async () => {
      // As the runtime's retryFailedRepair: a connect that arrives mid-repair
      // waits for it, and a rerun clears the flag as it starts, so of several
      // connects waiting on one failed attempt only the first retries it.
      await (repairRun?.done ?? Promise.resolve());
      if (!deps.isMounted() || !repairFailed) return;
      await run(rejectedError);
    },
    rejected: () => rejectedError,
    clear: () => { rejectedError = undefined; },
  };
}
