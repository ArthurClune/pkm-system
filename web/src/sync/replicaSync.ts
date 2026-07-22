// pattern: Imperative Shell
// Drives the replica from the server (spec section 3): snapshot bootstrap,
// nudge-driven windowed pulls, and the guarded re-bootstrap paths (feed
// reset / generation flip / schema-version mismatch). The guardrail from
// the epic: a re-bootstrap NEVER tears down a database whose pending queue
// is non-empty — queued batches are flushed to the server first (batch_id
// dedup makes replayed flushes safe), and a failed flush keeps the old
// database: degraded beats data loss.

import { ApiError } from "../api/client";
import type { Changes, Snapshot } from "../replica/apply";
import type { PendingBatch, RecoveryCommit, Replica } from "../replica/client";
import { ReplicaError } from "../replica/rpc";
import type { OpQueue } from "./opQueue";

export type ReplicaState =
  | { mode: "starting" }
  | { mode: "no-replica" }
  | { mode: "ready" }
  | { mode: "recovery-failed"; error: string }
  | { mode: "stalled"; error: string };

export interface ReplicaSync {
  /** Idempotent: first call initializes (+ bootstrap/recovery as needed);
   * later calls catch up the feed. Call on every reconnect. */
  start(): Promise<void>;
  /** WS nudge: pull if the journal moved past our cursor. */
  onSeq(seq: number): void;
  /** Resolves when no pull is in flight (tests, reconnect ordering). */
  idle(): Promise<void>;
  /** Full-snapshot poison repair under the shared recovery lease. Delivery
   * remains paused on return so the provider can delete the poison row, bump
   * view resync, and only then resume the queue. */
  rebaseAuthoritative(reason: "poison"): Promise<void>;
  /** Release poison recovery ownership after row deletion/resync scheduling.
   * This does not resume delivery; the provider owns that final ordering. */
  completeAuthoritativeRepair(reason: "poison"): void;
  /** Manual recovery for a wedged replica (incident: pullLoop failures were
   * silently swallowed and the cursor froze). Flushes pending writes (unless
   * discardPending) then rebuilds from a fresh snapshot. Throws
   * ResetBlockedError when discardPending is false and the flush fails. */
  resetLocalData(opts: { discardPending: boolean }): Promise<void>;
  /** Stops scheduling backoff retries and clears any pending retry timer.
   * The provider must call this on teardown (unmount) so a stopped instance
   * doesn't leak a timer that outlives its component; an in-flight pull may
   * still finish after stop() but will not reschedule another retry. */
  stop(): void;
}

/** Thrown by resetLocalData when discardPending is false and the pending-batch
 * flush fails: the caller must re-ask with discardPending true to proceed, or
 * leave the (still-intact) database alone. */
export class ResetBlockedError extends Error {
  constructor(readonly pending: number) {
    super("unsent changes not delivered");
  }
}

export const STALL_AFTER_FAILURES = 3;
export const PENDING_CHANGED_CAP = 20;
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 60000;

export interface ReplicaSyncDeps {
  replica: Replica;
  /** apiFetch-shaped; typed loosely so tests can hand in plain mocks. */
  fetchJson: (path: string, init?: RequestInit) => Promise<unknown>;
  clientId: string;
  onState: (s: ReplicaState) => void;
  /** Delivery is paused while the worker recovery lease owns the database. */
  queue?: Pick<OpQueue, "pause" | "resume"> &
    Partial<Pick<OpQueue, "onPoisonPending">>;
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** Thrown by pullLoop when the pending-batch id list never stops changing
 * (PENDING_CHANGED_CAP retries exhausted): a real replica-side stall, not a
 * transport hiccup, so noteFailure's classifier must recognize it by type
 * rather than by message text. */
class PullStarvedError extends Error {}

/** Network-down failures (dropped connection, DNS, an offline fetch) are not
 * wedged-replica symptoms -- the offline banner already owns network-down
 * UX, and counting them here would flip a whole offline session read-only
 * via computeEditability. Only failures that mean "the replica itself
 * cannot make progress" -- a rejected/failed API call, a replica-side RPC
 * error, or pull() starving on pending-batch churn -- count toward the
 * stall threshold; anything else still retries with backoff but is neither
 * counted nor reported as stalled. */
const isStallShaped = (error: unknown): boolean =>
  error instanceof ApiError || error instanceof ReplicaError ||
  error instanceof PullStarvedError;

export function createReplicaSync(deps: ReplicaSyncDeps): ReplicaSync {
  const { replica, fetchJson, clientId, onState } = deps;
  const queue = deps.queue ?? {
    pause: () => undefined,
    resume: () => undefined,
  };
  let cursor = 0;
  let started = false;
  let disabled = false; // no-replica: permanent for this session
  let pulling: Promise<void> | null = null;
  let again = false;
  let authoritativeRepair: "poison" | null = null;
  // A per-instance sentinel thrown to abort a normal-recovery flush that a
  // poison repair has preempted. It is caught by identity (=== below), never
  // by message; it is an Error (not a Symbol) only so it is a throwable the
  // lint's only-throw-error rule accepts -- the identity check is what matters.
  const poisonPreempted = new Error("poison preempted normal recovery");

  // Stall detection + backoff retry (Fix A): pullLoop errors used to be
  // swallowed outright, so a wedged replica had zero surfaced symptoms. A run
  // of consecutive failed pull attempts is now reported and retried with
  // growing backoff; `reportedNonReady` avoids re-announcing "ready" on every
  // ordinary successful pull -- only a pull that follows a reported failure
  // needs to clear it.
  let consecutiveFailures = 0;
  let retryDelay = RETRY_BASE_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let reportedNonReady = false;
  // Set by stop(): a torn-down instance must not leak a timer past unmount,
  // so a still-in-flight pull's eventual noteFailure must not reschedule.
  let stopped = false;

  const noteSuccess = (opts: { force?: boolean } = {}): void => {
    consecutiveFailures = 0;
    retryDelay = RETRY_BASE_MS;
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    if (reportedNonReady || opts.force) {
      reportedNonReady = false;
      onState({ mode: "ready" });
    }
  };

  const noteFailure = (error: unknown): void => {
    if (isStallShaped(error)) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= STALL_AFTER_FAILURES) {
        reportedNonReady = true;
        onState({ mode: "stalled", error: errText(error) });
      }
    }
    if (!stopped && retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void pull();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    }
  };

  // The queue fires this synchronously on the 4xx path, before the durable
  // poison mark and its public event. A normal recovery lease acquired just
  // before that mark therefore cannot flush its stale pre-mark batch list.
  queue.onPoisonPending?.(() => { authoritativeRepair = "poison"; });

  const bootstrap = async (): Promise<void> => {
    const snap = (await fetchJson("/api/sync/snapshot")) as Snapshot;
    await replica.applySnapshot(snap);
    cursor = snap.seq;
  };

  const assertNormalRecoveryStillOwnsFlush = (): void => {
    if (authoritativeRepair === "poison") throw poisonPreempted;
  };

  const flushBatches = async (
    batches: PendingBatch[],
    beforePost: () => void,
  ): Promise<void> => {
    for (const b of batches) {
      // poisoned batches were already rejected by the server; retrying
      // them forever would wedge recovery (spec section 6)
      if (b.poisoned) continue;
      beforePost();
      await fetchJson("/api/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, batch_id: b.batch_id,
                               ops: b.ops }),
      });
    }
  };

  const runRecovery = async (kind: RecoveryCommit["kind"], options: {
    flush: boolean;
    resume: boolean;
    reportReplicaFailure: boolean;
  }): Promise<void> => {
    queue.pause("recovery");
    let token: string | null = null;
    try {
      const lease = await replica.prepareRecovery();
      token = lease.token;
      if (options.flush) {
        assertNormalRecoveryStillOwnsFlush();
        await flushBatches(
          [...lease.batches], assertNormalRecoveryStillOwnsFlush,
        );
      }
      const snapshot = (await fetchJson("/api/sync/snapshot")) as Snapshot;
      await replica.commitRecovery(token, { kind, snapshot });
      token = null; // commit released the worker gate
      cursor = snapshot.seq;
    } catch (error: unknown) {
      const poisonOwnsRecovery = authoritativeRepair === "poison" ||
        error === poisonPreempted;
      if (options.reportReplicaFailure && !poisonOwnsRecovery) {
        // Without this, a recovery-failed report that never crosses the
        // stall threshold (e.g. the very first failure) leaves
        // reportedNonReady false, so noteSuccess's later "ready" re-emission
        // is gated off and the banner (plus the stale replicaState it
        // reflects) sticks forever despite a healthy replica.
        reportedNonReady = true;
        onState({ mode: "recovery-failed", error: errText(error) });
      }
      if (token !== null) {
        // Commit failures release in the worker; abort is still attempted so
        // transport failures cannot leave a known lease held. Double-token
        // rejection is deliberately ignored in favor of the original error.
        try { await replica.abortRecovery(token); } catch { /* already released */ }
      }
      throw error;
    } finally {
      if (options.resume && authoritativeRepair !== "poison") {
        queue.resume("recovery");
      }
    }
  };

  const recover = async (kind: RecoveryCommit["kind"]): Promise<boolean> => {
    try {
      await runRecovery(kind, {
        flush: true, resume: true, reportReplicaFailure: true,
      });
      return true;
    } catch {
      return false;
    }
  };

  const pullLoop = async (): Promise<void> => {
    // Counts consecutive "pending-changed" refetches across this whole call
    // (including across an `again`-triggered restart): a feed that never
    // stops racing the local queue must eventually be treated as a failed
    // pull attempt rather than spin forever.
    let pendingChangedRetries = 0;
    do {
      again = false;
      let done = false;
      while (!done) {
        const expectedPendingIds = (await replica.pendingBatches())
          .map((batch) => batch.id);
        const feed = (await fetchJson(
          `/api/sync/changes?since=${cursor}`)) as Changes;
        const res = await replica.applyChanges(feed, expectedPendingIds);
        if (res.status === "pending-changed") {
          pendingChangedRetries += 1;
          if (pendingChangedRetries >= PENDING_CHANGED_CAP) {
            throw new PullStarvedError(
              "pull starved: pending batches kept changing");
          }
          continue;
        }
        if (res.status === "needs-bootstrap") {
          // A rejected batch owns recovery until the provider has deleted its
          // durable row and scheduled resync. Normal Task 2 recovery would
          // flush later valid rows and resume a boolean-paused queue, breaking
          // poison's stronger ordering and failed-Retry barrier.
          if (authoritativeRepair === "poison") return;
          if (!(await recover("rebase"))) {
            // A poison signal that arrived mid-recovery (flush-time
            // preemption) is already reported/retried by its own owner and
            // must stay silent here too; any other recovery failure is a
            // genuine failed pull attempt.
            if (authoritativeRepair === "poison") return;
            throw new Error("replica recovery failed during pull");
          }
          done = feed.latest_seq <= cursor;
        } else {
          cursor = res.cursor;
          done = feed.next_since >= feed.latest_seq;
        }
      }
    } while (again);
  };

  const pull = (): Promise<void> => {
    if (!started) return Promise.resolve();
    if (pulling) {
      again = true;
      return pulling;
    }
    pulling = pullLoop()
      .then(() => noteSuccess(), (error: unknown) => noteFailure(error))
      .finally(() => { pulling = null; });
    return pulling;
  };

  const doStart = async (): Promise<void> => {
    const init = await replica.init();
    if (!init.ok) {
      disabled = true;
      onState({ mode: "no-replica" });
      return;
    }
    cursor = init.cursor;
    if (init.schemaMismatch) {
      // deploy changed the DDL: one coordinator flushes and rebuilds under
      // the same worker lease used for feed generation/reset recovery.
      if (!(await recover("reset"))) return;
    } else if (init.empty) {
      await bootstrap();
    }
    started = true;
    onState({ mode: "ready" });
    await pull();
  };
  let starting: Promise<void> | null = null;

  return {
    async start() {
      if (disabled) return;
      if (started) {
        await pull();
        return;
      }
      // single-flight: the mount-time start (cold start offline needs no
      // socket) and the first connect's start must share one initialization
      starting ??= doStart().finally(() => { starting = null; });
      await starting;
    },
    onSeq(seq) {
      if (pulling) {
        // a window is in flight; its server-side latest_seq may predate
        // this nudge, so ask for one trailing pull instead of dropping it
        again = true;
        return;
      }
      if (!started || seq <= cursor) return;
      void pull();
    },
    idle() {
      return pulling ?? Promise.resolve();
    },
    async rebaseAuthoritative(_reason) {
      // Unlike schema/generation recovery, poison repair must not flush later
      // valid rows before the rejected optimistic state has been removed. A
      // pull that already passed Task 1's pending-id guard must finish first;
      // otherwise its stale window could apply after the full snapshot and
      // move the cursor/state backwards.
      authoritativeRepair = "poison";
      queue.pause("recovery");
      await (pulling ?? Promise.resolve());
      await runRecovery("rebase", {
        flush: false, resume: false, reportReplicaFailure: false,
      });
    },
    completeAuthoritativeRepair(reason) {
      if (authoritativeRepair === reason) authoritativeRepair = null;
    },
    async resetLocalData({ discardPending }) {
      // A rejected-batch repair owns recovery until the provider has deleted
      // its durable row and scheduled resync; a manual reset must not steal
      // that lease out from under it (mirrors the needs-bootstrap guard in
      // pullLoop). Bail before touching the queue or acquiring a lease.
      if (authoritativeRepair === "poison") {
        throw new Error("rejected-batch repair in progress");
      }
      queue.pause("recovery");
      let token: string | null = null;
      try {
        // Unlike schema/generation recovery, a manual reset must not tear
        // down a database out from under a pull that already passed the
        // pending-id guard; that pull's stale window could otherwise apply
        // after the full snapshot and move the cursor/state backwards.
        await (pulling ?? Promise.resolve());
        const lease = await replica.prepareRecovery();
        token = lease.token;
        if (!discardPending) {
          try {
            await flushBatches([...lease.batches], () => undefined);
          } catch {
            throw new ResetBlockedError(
              lease.batches.filter((b) => !b.poisoned).length,
            );
          }
        }
        const snapshot = (await fetchJson("/api/sync/snapshot")) as Snapshot;
        await replica.commitRecovery(token, { kind: "reset", snapshot });
        token = null; // commit released the worker gate
        cursor = snapshot.seq;
        // Unlike ordinary pull success, a reset must report ready even when
        // no prior failure was announced, and must (re)enable pulls: it can
        // resolve a recovery-failed state that left `started` false (a
        // failed doStart never got here) as well as one where it was already
        // true (a failed in-pull recovery).
        started = true;
        noteSuccess({ force: true });
      } catch (error: unknown) {
        if (token !== null) {
          try { await replica.abortRecovery(token); } catch { /* already released */ }
        }
        throw error;
      } finally {
        if (authoritativeRepair !== "poison") {
          queue.resume("recovery");
        }
      }
    },
    stop() {
      stopped = true;
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    },
  };
}
