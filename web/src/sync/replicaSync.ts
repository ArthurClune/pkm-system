// pattern: Imperative Shell
// Drives the replica from the server (spec section 3): snapshot bootstrap,
// nudge-driven windowed pulls, and the guarded re-bootstrap paths (feed
// reset / generation flip / schema-version mismatch). The guardrail from
// the epic: a re-bootstrap NEVER tears down a database whose pending queue
// is non-empty — queued batches are flushed to the server first (batch_id
// dedup makes replayed flushes safe), and a failed flush keeps the old
// database: degraded beats data loss.

import { ApiError, OfflineError } from "../api/client";
import type { ApiFetchOptions } from "../api/client";
import type { Changes, Snapshot } from "../replica/apply";
import type {
  PendingBatch, RecoveryCommit, RecoveryLease, Replica, ReplicaInit,
} from "../replica/client";
import { availabilityOf, ReplicaError } from "../replica/errors";
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
  /** WS nudge: pull if the journal moved past our cursor, or unconditionally
   * for a committed metadata/generation frame whose real seq may be equal. */
  onSeq(seq: number, force?: boolean): void;
  /** Resolves when no pull is in flight (tests, reconnect ordering). */
  idle(): Promise<void>;
  /** Monotonic count of the moments local data actually moved: a changes
   * window that advanced the cursor, a snapshot bootstrap, or a recovery
   * rebuild. A reconnect that leaves this unchanged has nothing for any view
   * to refetch (pkm-5fak) — which is the common case on a flapping link.
   *
   * `null` means the question cannot be answered: this session has no usable
   * database, so there is no cursor to compare and the caller must assume the
   * worst. Two things put it there — a failed open at startup, and a pull that
   * rejects with the worker's own latched open failure, which is how a database
   * that dies mid-session announces itself.
   *
   * An ordinary failed pull is deliberately NOT null: the cursor is the durable
   * memory of what has been seen, so the next successful reconnect pulls the
   * same window again and reports the change then. That reasoning only holds
   * while a later pull can succeed, which is exactly what the latch rules out
   * (only close() re-arms it) — hence the second null case. */
  appliedVersion(): number | null;
  /** True once doStart emits `onState({ mode: "ready" })` (set in the same
   * synchronous step, just before the emit): the local database already has
   * a usable snapshot, whether this call's start() bootstrapped it just now
   * or it was already populated (this session, or persisted from a previous
   * one). False for a mount that has never completed a bootstrap -- the
   * offline-cold-start gap useSocketLifecycle's first-connect gate closes
   * (pkm-8k2c): a failed start() while offline leaves this false, so the
   * first connect once online still knows to run the reconnect protocol even
   * with an empty durable queue. Never goes back to false once true. */
  hasStarted(): boolean;
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
 * leave the (still-intact) database alone. `cause` carries the flush failure
 * itself, so a transport failure and a server rejection stay distinguishable
 * behind the one "reset blocked" message. */
export class ResetBlockedError extends Error {
  constructor(readonly pending: number, options?: { cause?: unknown }) {
    super("unsent changes not delivered", options);
  }
}

export const STALL_AFTER_FAILURES = 3;
export const PENDING_CHANGED_CAP = 20;
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 60000;

/** The snapshot is the one read here that is exempt from the ordinary read
 * deadline (pkm-d6i6): its size grows with the graph, so on a slow link a
 * cold-start bootstrap can legitimately outlast any deadline picked for small
 * reads, and aborting it only restarts the same download. A link that is dead
 * rather than slow is still caught -- by noteFailure's backoff for the pull
 * path, and by the recovery entrants' own error handling. */
const UNTIMED: ApiFetchOptions = { timeoutMs: null };

export interface ReplicaSyncDeps {
  replica: Replica;
  /** apiFetch-shaped; typed loosely so tests can hand in plain mocks. */
  fetchJson: (
    path: string, init?: RequestInit, opts?: ApiFetchOptions,
  ) => Promise<unknown>;
  clientId: string;
  onState: (s: ReplicaState) => void;
  /** Delivery is paused while the worker recovery lease owns the database. */
  queue?: Pick<OpQueue, "pause" | "resume"> &
    Partial<Pick<OpQueue, "onPoisonPending">>;
  /** True while the socket is down (mirrors the offline gateway's own
   * `statusRef.current === "reconnecting"` predicate). A failed pull's retry
   * is pointless here -- every retry while offline just reproduces the same
   * `OfflineError` -- and the reconnect flow already calls `start()` (hence
   * `pull()`) the moment the socket comes back up, so nothing is lost by not
   * arming the timer. Defaults to "never offline" for callers (and tests)
   * that don't track connectivity. */
  isOffline?: () => boolean;
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** What a recovery run does with the lease's pending batches. The queue is the
 * user's intent, so this is a policy per entrant rather than a boolean. */
type FlushPolicy =
  /** Post nothing: poison repair must not push later valid rows ahead of a
   * batch the server already refused. */
  | "skip"
  /** Post oldest-first, abandoning the run the moment a poison repair claims
   * recovery — the lease's batch list was read before the durable mark, so it
   * is stale. */
  | "preemptible"
  /** Post oldest-first, and treat failure as a refusal rather than an outage:
   * the caller gets `ResetBlockedError` and an intact database, and must
   * re-ask with discardPending to proceed. */
  | "blocking";

/** Everything that differs between the entrants to the recovery lease
 * (schema/feed recovery, poison repair, manual reset), named here so the
 * lifecycle itself exists once. */
interface RecoveryOptions {
  flush: FlushPolicy;
  /** Release the delivery barrier when the run ends. False only for poison
   * repair, where the provider resumes after deleting the durable row and
   * scheduling resync. */
  resume: boolean;
  /** Report mode "recovery-failed" when the run throws. False where the
   * caller owns the report: poison repair and the manual reset each have
   * their own banner, and a stall report over it would contradict them. */
  reportReplicaFailure: boolean;
  /** Wait for a pull that already passed the pending-id guard before taking
   * the lease: its stale window could otherwise apply after the fresh
   * snapshot and move the cursor/state backwards. Must stay false for
   * recovery that runs *inside* pullLoop, which would deadlock awaiting the
   * pull it is part of. */
  awaitInFlightPull: boolean;
  /** Force mode "ready" and (re)enable pulls after the commit. Only the
   * manual reset does this: it resolves a recovery-failed state whether or
   * not a failure was ever announced, and whether `started` was left false by
   * a failed doStart or true by a failed in-pull recovery. */
  forceReadyOnSuccess: boolean;
}

/** Thrown by pullLoop when the pending-batch id list never stops changing
 * (PENDING_CHANGED_CAP retries exhausted): a real replica-side stall, not a
 * transport hiccup, so noteFailure's classifier must recognize it by type
 * rather than by message text. */
class PullStarvedError extends Error {}

/** Network-down failures (dropped connection, DNS, an offline fetch) are not
 * wedged-replica symptoms -- the offline banner already owns network-down
 * UX, and counting them here would flip a whole offline session read-only
 * via computeEditability. A raw `fetch` rejection (`TypeError`) is excluded
 * simply by not matching any branch below; `OfflineError` needs its own
 * check because it extends `ApiError` (status 0, thrown when the offline
 * gateway has no local route for a request) and would otherwise pass the
 * `instanceof ApiError` branch as if the server itself had rejected the call
 * (pkm-gw5r: three offline pulls crossed STALL_AFTER_FAILURES and raised the
 * "Local sync is stuck / Reset local data" banner for a plain network
 * outage). Availability failures are excluded for the same offline-banner
 * reason and more sharply: a session that reports `stalled` on top of
 * `no-replica` is reporting a wedged replica it has already concluded does not
 * exist, and computeEditability would take editing away for the rest of the
 * session (pkm-y35i). Only failures that mean "the replica itself cannot make
 * progress" -- a rejected/failed API call, a replica-side RPC error, or pull()
 * starving on pending-batch churn -- count toward the stall threshold;
 * anything else still retries with backoff but is neither counted nor reported
 * as stalled. */
const isStallShaped = (error: unknown): boolean =>
  availabilityOf(error) === null &&
  !(error instanceof OfflineError) &&
  (error instanceof ApiError || error instanceof ReplicaError ||
    error instanceof PullStarvedError);

export function createReplicaSync(deps: ReplicaSyncDeps): ReplicaSync {
  const { replica, fetchJson, clientId, onState } = deps;
  const queue = deps.queue ?? {
    pause: () => undefined,
    resume: () => undefined,
  };
  const isOffline = deps.isOffline ?? (() => false);
  let cursor = 0;
  // See appliedVersion(): bumped only through adoptCursor, so a new place that
  // moves the replica forward has to state whether views must refetch.
  let appliedVersion = 0;
  let usable = true;
  let started = false;
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
    // The only place after startup where "there is no usable database" can
    // still be learned: doStart's catch has already run, and a worker that
    // latches its own failed open mid-session rejects every pull with it until
    // close(). Without this latch appliedVersion() would freeze at its last
    // value and answer "nothing moved" for the rest of the session, so no
    // reconnect would ever refetch a view again (pkm-5fak). Note this is a
    // report about the database, not about the pull attempt: isStallShaped
    // still excludes it from the stall count and the retry below still runs.
    if (availabilityOf(error) === "unusable") usable = false;
    if (isStallShaped(error)) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= STALL_AFTER_FAILURES) {
        reportedNonReady = true;
        onState({ mode: "stalled", error: errText(error) });
      }
    }
    // No timer while offline: every retry would just reproduce the same
    // OfflineError, and the reconnect flow's own start() call resumes the
    // pull the moment the socket reconnects (pkm-gw5r) -- an armed timer here
    // only costs a wakeup roughly once a minute for nothing.
    if (!stopped && !isOffline() && retryTimer === null) {
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

  /** Local data now reflects `seq`. A `"snapshot"` always replaced the
   * database; a `"window"` only moved it if the feed had rows to apply, which
   * is exactly when `next_since` advances past the cursor we asked from. */
  const adoptCursor = (seq: number, source: "window" | "snapshot"): void => {
    if (source === "snapshot" || seq > cursor) appliedVersion += 1;
    cursor = seq;
  };

  const fetchSnapshot = async (): Promise<Snapshot> =>
    (await fetchJson("/api/sync/snapshot", undefined, UNTIMED)) as Snapshot;

  const bootstrap = async (): Promise<void> => {
    const snap = await fetchSnapshot();
    await replica.applySnapshot(snap);
    adoptCursor(snap.seq, "snapshot");
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

  const flushLease = async (
    lease: RecoveryLease, policy: FlushPolicy,
  ): Promise<void> => {
    if (policy === "skip") return;
    if (policy === "preemptible") {
      assertNormalRecoveryStillOwnsFlush();
      await flushBatches(
        [...lease.batches], assertNormalRecoveryStillOwnsFlush,
      );
      return;
    }
    if (policy === "blocking") {
      try {
        await flushBatches([...lease.batches], () => undefined);
      } catch (cause: unknown) {
        throw new ResetBlockedError(
          lease.batches.filter((b) => !b.poisoned).length, { cause },
        );
      }
      return;
    }
    const exhaustive: never = policy;
    throw new Error(`unhandled flush policy: ${String(exhaustive)}`);
  };

  /** The one recovery-lease lifecycle: barrier, lease, flush, snapshot,
   * commit, release. Every entrant runs it with different `RecoveryOptions`
   * rather than its own copy, so a lease-handling fix lands once. */
  const runRecovery = async (
    kind: RecoveryCommit["kind"], options: RecoveryOptions,
  ): Promise<void> => {
    queue.pause("recovery");
    let token: string | null = null;
    try {
      if (options.awaitInFlightPull) await (pulling ?? Promise.resolve());
      const lease = await replica.prepareRecovery();
      token = lease.token;
      await flushLease(lease, options.flush);
      const snapshot = await fetchSnapshot();
      await replica.commitRecovery(token, { kind, snapshot });
      token = null; // commit released the worker gate
      adoptCursor(snapshot.seq, "snapshot");
      if (options.forceReadyOnSuccess) {
        started = true;
        noteSuccess({ force: true });
      }
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

  // Returns the underlying failure (not just a boolean) so a caller that
  // re-throws on failure -- pullLoop's needs-bootstrap path -- can preserve
  // the original error's type for isStallShaped instead of rethrowing a
  // synthetic stand-in that always classifies as network-shaped (pkm-913m).
  const recover = async (
    kind: RecoveryCommit["kind"],
  ): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    try {
      await runRecovery(kind, {
        flush: "preemptible", resume: true, reportReplicaFailure: true,
        // this runs inside pullLoop; see RecoveryOptions
        awaitInFlightPull: false, forceReadyOnSuccess: false,
      });
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error };
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
          const rebased = await recover("rebase");
          if (!rebased.ok) {
            // A poison signal that arrived mid-recovery (flush-time
            // preemption) is already reported/retried by its own owner and
            // must stay silent here too; any other recovery failure is a
            // genuine failed pull attempt -- rethrow the real error so
            // isStallShaped classifies it correctly (pkm-913m) instead of a
            // synthetic stand-in that always looked network-shaped.
            if (authoritativeRepair === "poison") return;
            throw rebased.error;
          }
          done = feed.latest_seq <= cursor;
        } else {
          adoptCursor(res.cursor, "window");
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
    let init: ReplicaInit;
    try {
      init = await replica.init();
    } catch (error: unknown) {
      // "unusable" is the worker reporting its own latched failed open: this
      // session is online-only, and no later start() can revive it, because the
      // latch replays for every call until close(). That is what replaces the
      // `disabled` boolean this function used to set — the session-commitment
      // moment moves to where the commitment actually happens (pkm-61zt).
      //
      // Anything else, INCLUDING "unreachable", stays an ordinary start
      // failure: "we could not ask" is not evidence there is no database, and
      // isStallShaped already excludes it from the stall count.
      if (availabilityOf(error) === "unusable") {
        // No database this session can ever read, so no cursor to compare:
        // appliedVersion() goes null and every reconnect refetches views.
        usable = false;
        onState({ mode: "no-replica" });
        return;
      }
      throw error;
    }
    // Not adoptCursor: this reads the cursor the database already holds, so
    // nothing moved and no view has anything new to fetch.
    cursor = init.cursor;
    if (init.schemaMismatch) {
      // deploy changed the DDL: one coordinator flushes and rebuilds under
      // the same worker lease used for feed generation/reset recovery.
      if (!(await recover("reset")).ok) return;
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
      if (started) {
        await pull();
        return;
      }
      // single-flight: the mount-time start (cold start offline needs no
      // socket) and the first connect's start must share one initialization
      starting ??= doStart().finally(() => { starting = null; });
      await starting;
    },
    onSeq(seq, force = false) {
      if (pulling) {
        // a window is in flight; its server-side latest_seq or metadata may
        // predate this nudge, so ask for one trailing pull instead of dropping it
        again = true;
        return;
      }
      if (!started || (!force && seq <= cursor)) return;
      void pull();
    },
    idle() {
      return pulling ?? Promise.resolve();
    },
    appliedVersion() {
      return usable ? appliedVersion : null;
    },
    hasStarted() {
      return started;
    },
    async rebaseAuthoritative(_reason) {
      // Ownership is claimed before the barrier so a concurrent normal
      // recovery abandons its stale flush; the rest is the shared lifecycle
      // under poison's options (no flush of later valid rows, no resume, no
      // report of its own).
      authoritativeRepair = "poison";
      await runRecovery("rebase", {
        flush: "skip", resume: false, reportReplicaFailure: false,
        awaitInFlightPull: true, forceReadyOnSuccess: false,
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
      // A session committed to online-only must stay that way: this method sets
      // started and forces mode "ready", which would revive syncing with poison
      // discovery skipped. Nothing needs to check a flag for that — every
      // database call below replays the worker's latched open failure, and
      // prepareRecovery is the first of them, so this throws long before
      // `started = true` is reached. No UI path reaches this today anyway (the
      // reset control needs a stalled/recovery-failed mode, and neither can
      // arise once the replica is unavailable) — pkm-bjae, pkm-61zt.
      await runRecovery("reset", {
        // discarding is the user answering the ResetBlockedError question
        flush: discardPending ? "skip" : "blocking",
        resume: true,
        // SyncProvider turns this rejection into its own reset-failed banner
        reportReplicaFailure: false,
        awaitInFlightPull: true,
        forceReadyOnSuccess: true,
      });
    },
    stop() {
      stopped = true;
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    },
  };
}
