// pattern: Imperative Shell
// The reconnect protocol SyncProvider's mount effect used to inline: after a
// gap, flush the preserved ops first, then pull the changes feed, then bump
// resyncGeneration so views refetch state that already reflects both
// (flush -> pull -> resync, spec sections 3/6).
//
// The bump is conditional on the catch-up having moved local data, because a
// flapping link otherwise makes every 2 s blip cost a full refetch of every
// view. The order is unchanged; only *whether* to refetch narrows.
// Two things make the replica's own cursor the right thing to ask:
//   * a drain that delivered ops needs no signal of its own — the POST commits
//     server-side before it resolves, and the drain resolves before the pull
//     starts, so those rows are in the very window this pull reads;
//   * everything that landed while the socket was UP was already delivered to
//     the views as WS batches, so "moved since this reconnect began" is the
//     same question as "moved since the views were last correct".
// That second equivalence is exactly what a FIRST connect does not have — its
// views read the server before any of this session's catch-up ran — which is
// why `begin({ viewsAreStale: true })` exists and skips the comparison.
//
// Two entrants share ONE completion (the single-flight `finishRun`):
//   * `begin()` — a socket (re)connect, which drains first;
//   * `observeDrain()` — the queue's own drain observer, so a drain that
//     completes out of band (an automatic retry after a blocked flush) still
//     finishes the reconnect that is waiting on it.
// A reconnect first reruns a poison repair whose last attempt failed
// (`retryFailedRepair`, the runtime's): that repair holds the recovery
// barrier, so nothing below it can deliver until it succeeds, and a repair
// cut off by the network going down has no other trigger. It runs from
// begin() only, once per (re)connect; observeDrain fires on every drain while
// connected and never calls it, so a repair that fails again waits for the
// next connect instead of looping.
//
// `intent` is what makes overlapping reconnects collapse: a second connect
// while a completion is already running joins that run instead of scheduling
// another feed pull, and no stale intent survives it.
import type { DrainOutcome, OpQueue } from "./opQueue";
import type { ReplicaSync } from "./replicaSync";

export interface ReconnectFlow {
  /** A socket (re)connect: drain, and finish only if the drain got through.
   * `viewsAreStale` skips the "did anything move?" comparison and always
   * resyncs — for a caller that already knows the views read the server
   * before this catch-up, which no cursor position can tell it. */
  begin(opts?: { viewsAreStale?: boolean }): Promise<void>;
  /** Queue drain observation: completes a reconnect waiting on that drain. */
  observeDrain(outcome: DrainOutcome): void;
}

export function createReconnectFlow(deps: {
  queue: Pick<OpQueue, "drain">;
  replicaSync: Pick<ReplicaSync, "start" | "idle" | "appliedVersion"> | null;
  /** False after unmount: nothing may be finished or resynced past it. */
  isMounted: () => boolean;
  onResync: () => void;
  /** A connect's first step: the client runtime's retryFailedRepair, or a
   * resolved promise when there is no runtime. Required, so that no caller
   * can drop the retry by leaving it out. */
  retryFailedRepair: () => Promise<void>;
}): ReconnectFlow {
  let intent = false;
  // Rides with the intent, not the call: a stale-views drain that gets through
  // out of band must still resync unconditionally when observeDrain finishes it.
  let staleViews = false;
  let finishRun: Promise<void> | null = null;

  const finish = (): Promise<void> => {
    if (!deps.isMounted()) return Promise.resolve();
    if (!intent) return finishRun ?? Promise.resolve();
    intent = false;
    if (finishRun) return finishRun;
    finishRun = (async () => {
      const before = deps.replicaSync?.appliedVersion() ?? null;
      await deps.replicaSync?.start();
      await deps.replicaSync?.idle();
      const after = deps.replicaSync?.appliedVersion() ?? null;
      // Read at the decision, not at the start of the run, so a stale-views
      // connect that JOINED this completion is still honoured by it.
      const unconditional = staleViews;
      staleViews = false;
      // Refetch only when the catch-up actually moved local data.
      // `null` on either side is "cannot tell" — no replica, or one this
      // session can never use — and must count as moved, or an online-only
      // session would stop refreshing its views altogether.
      const moved = unconditional ||
        before === null || after === null || before !== after;
      if (deps.isMounted() && moved) deps.onResync();
    })().finally(() => { finishRun = null; });
    return finishRun;
  };

  return {
    begin: async (opts) => {
      intent = true;
      staleViews = staleViews || opts?.viewsAreStale === true;
      if (deps.isMounted()) await deps.retryFailedRepair();
      const outcome = await deps.queue.drain();
      if (outcome.status !== "drained" || !deps.isMounted()) return;
      await finish();
    },
    observeDrain: (outcome) => {
      if (outcome.status === "drained") void finish().catch(() => undefined);
    },
  };
}
