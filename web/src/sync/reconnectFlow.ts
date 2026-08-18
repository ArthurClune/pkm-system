// pattern: Imperative Shell
// The reconnect protocol SyncProvider's mount effect used to inline: after a
// gap, flush the preserved ops first, then pull the changes feed, then bump
// resyncSeq so views refetch state that already reflects both
// (flush -> pull -> resync, spec sections 3/6).
//
// Two entrants share ONE completion (the single-flight `finishRun`):
//   * `begin()` — a socket (re)connect, which drains first;
//   * `observeDrain()` — the queue's own drain observer, so a drain that
//     completes out of band (an automatic retry after a blocked flush) still
//     finishes the reconnect that is waiting on it.
// `intent` is what makes overlapping reconnects collapse: a second connect
// while a completion is already running joins that run instead of scheduling
// another feed pull, and no stale intent survives it.
import type { DrainOutcome, OpQueue } from "./opQueue";
import type { ReplicaSync } from "./replicaSync";

export interface ReconnectFlow {
  /** A socket (re)connect: drain, and finish only if the drain got through. */
  begin(): Promise<void>;
  /** Queue drain observation: completes a reconnect waiting on that drain. */
  observeDrain(outcome: DrainOutcome): void;
}

export function createReconnectFlow(deps: {
  queue: Pick<OpQueue, "drain">;
  replicaSync: Pick<ReplicaSync, "start" | "idle"> | null;
  /** False after unmount: nothing may be finished or resynced past it. */
  isMounted: () => boolean;
  onResync: () => void;
}): ReconnectFlow {
  let intent = false;
  let finishRun: Promise<void> | null = null;

  const finish = (): Promise<void> => {
    if (!deps.isMounted()) return Promise.resolve();
    if (!intent) return finishRun ?? Promise.resolve();
    intent = false;
    if (finishRun) return finishRun;
    finishRun = (async () => {
      await deps.replicaSync?.start();
      await deps.replicaSync?.idle();
      if (deps.isMounted()) deps.onResync();
    })().finally(() => { finishRun = null; });
    return finishRun;
  };

  return {
    begin: async () => {
      intent = true;
      const outcome = await deps.queue.drain();
      if (outcome.status !== "drained" || !deps.isMounted()) return;
      await finish();
    },
    observeDrain: (outcome) => {
      if (outcome.status === "drained") void finish().catch(() => undefined);
    },
  };
}
