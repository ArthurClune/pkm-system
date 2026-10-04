// pattern: Imperative Shell
// Drives the replica from the server (spec section 3): snapshot bootstrap,
// nudge-driven windowed pulls, and the guarded re-bootstrap paths (feed
// reset / generation flip / schema-version mismatch). The guardrail from
// the epic: a re-bootstrap NEVER tears down a database whose pending queue
// is non-empty — queued batches are flushed to the server first (batch_id
// dedup makes replayed flushes safe), and a failed flush keeps the old
// database: degraded beats data loss.

import type { ApiFetchOptions } from "../api/client";
import type { BatchId, ClientId, SyncSeq } from "../api/brands";
import type { OpsAck, SkippedOp } from "../api/payloads";
import type { ApplyResult, Changes, Snapshot } from "../replica/apply";
import type { ReplicaDiagnostics } from "../replica/client";
import type {
  AckedBatch, PendingBatch, RecoveryCommit, RecoveryLease, Replica, ReplicaInit,
} from "../replica/client";
import { availabilityOf } from "../replica/errors";
import { listeners } from "./listeners";
import type { OpQueue } from "./opQueue";
import { readOpsAck } from "./opsAck";
import { isFreshCorruption, isStallShaped, isWindowFailure, PullStarvedError } from "./syncFailures";

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
  onSeq(seq: SyncSeq, force?: boolean): void;
  /** Resolves when no pull is in flight (tests, reconnect ordering). */
  idle(): Promise<void>;
  /** Monotonic count of the moments local data actually moved: a changes
   * window that advanced the cursor, a snapshot bootstrap, or a recovery
   * rebuild. A reconnect that leaves this unchanged has nothing for any view
   * to refetch — which is the common case on a flapping link.
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
   * offline-cold-start gap useSocketLifecycle's first-connect gate closes:
   * a failed start() while offline leaves this false, so the
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
  /** The recovery flush's ack named a skipped op, or a sync payload named a
   * pending batch as already applied whose stored ack did -- the same signal
   * as the queue's own onSkipped, for the paths outside the queue's drain:
   * the active view is stale and must refetch. Never a desync: the batch
   * committed. */
  onSkipped(fn: () => void): () => void;
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
/** How many times the SAME changes window must fail the SAME way before it is
 * treated as unappliable and rebased away. Equal to STALL_AFTER_FAILURES on
 * purpose, which is the largest value that still acts first: each failed pull
 * increments both counters, but this one is counted (and short-circuits the
 * throw) inside pullLoop, whereas noteFailure only sees the failures that
 * escape it. So the Nth identical failure rebases instead of becoming
 * noteFailure's Nth increment, and the "Local sync is stuck" banner never
 * appears for a window a snapshot can clear. One higher and the banner would
 * be raised first, which is the wedge this exists to remove. */
export const WINDOW_STRIKES = STALL_AFTER_FAILURES;
export const PENDING_CHANGED_CAP = 20;
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 60000;
/** How many pending batch ids a pull names to the server, from the head of
 * the queue. Delivery is in queue order, so only a head prefix can be
 * committed while still pending: the drain holds at most its head in doubt,
 * and only a recovery flush whose commit never ran (then a reload, which
 * loses its held acks) leaves more. The ids ride the GET's query string.
 * Measured: 100 web batch ids (16 characters) add about 2.5 KB to the URL,
 * and 7.3 KB even at the 64 characters the server accepts, under the 8 KB
 * request line common proxies allow; uvicorn itself took 87 KB. The server's
 * lookup for 100 named batches cost about 0.3 ms. */
export const PENDING_IDS_CAP = 100;

/** The snapshot is the one read here that is exempt from the ordinary read
 * deadline: its size grows with the graph, so on a slow link a
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
  clientId: ClientId;
  onState: (s: ReplicaState) => void;
  /** Delivery is paused while the worker recovery lease owns the database.
   * `deliverLaneAhead` is how the recovery flush below gets the drain's own
   * lane-ordering guarantee: this flush posts leased durable rows
   * on its own, knowing nothing about the lane, so flushBatches asks the
   * queue to deliver whatever the lane holds ahead of each one first. */
  queue?: Pick<OpQueue, "pause" | "resume"> &
    Partial<Pick<OpQueue, "onPoisonPending" | "onPoisonMarkUnmatched" |
                          "deliverLaneAhead" | "settleCommitted">>;
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

/** The query naming the pending batches a payload may already hold: the
 * non-poisoned head of the queue, at most PENDING_IDS_CAP of them, oldest
 * first. Empty when there are none, so the request is unchanged then. A
 * poisoned batch is left out: the server refused it, and the poison repair
 * owns its row. */
const pendingQuery = (batches: readonly PendingBatch[]): string => {
  const params = new URLSearchParams();
  for (const b of batches.filter((batch) => !batch.poisoned)
                         .slice(0, PENDING_IDS_CAP)) {
    params.append("pending", b.batch_id);
  }
  return params.toString();
};

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

/** Which kind of iPad context this is: a home-screen app (`standalone`) and
 * Safari hold independent replicas, and the report has to say which one
 * broke. Node (tests) has no navigator. */
const clientInfo = (): Record<string, unknown> => {
  if (typeof navigator === "undefined") return {};
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    userAgent: nav.userAgent,
    standalone: nav.standalone ?? null,
    visibility: typeof document === "undefined" ? null : document.visibilityState,
  };
};

export function createReplicaSync(deps: ReplicaSyncDeps): ReplicaSync {
  const { replica, fetchJson, clientId, onState } = deps;
  const skipped = listeners<void>();
  const queue = deps.queue ?? {
    pause: () => undefined,
    resume: () => undefined,
  };
  const isOffline = deps.isOffline ?? (() => false);
  let cursor = 0 as SyncSeq;
  // See appliedVersion(): bumped only through adoptCursor, so a new place that
  // moves the replica forward has to state whether views must refetch.
  let appliedVersion = 0;
  let usable = true;
  let started = false;
  // The one automatic rebuild a corrupt replica gets per session; see
  // claimCorruptionRebuild.
  let rebuiltForCorruption = false;
  // The one automatic rebase an unappliable window gets per session, and the
  // run of identical failures that earns it; see noteWindowFailure.
  let rebasedForUnappliableWindow = false;
  let windowFailure: { cursor: SyncSeq; message: string; count: number } | null
    = null;
  let pulling: Promise<void> | null = null;
  let again = false;
  let authoritativeRepair: "poison" | null = null;
  // Acks the server gave for leased batches whose rows are still queued. The
  // next commit takes them, so a rebase deletes those rows before its replay
  // instead of replaying their wire text over what the server saved. A run
  // that ends before its commit (a preempted flush, a failed snapshot fetch)
  // leaves them for the one that follows, and a commit that fails hands them
  // back. A held ack whose row has since gone matches nothing in the worker.
  // They are memory only, so the rule holds within a session: after a reload
  // the acked rows are replayed and re-posted, and the server's stored ack
  // deletes them.
  let heldAcks: AckedBatch[] = [];
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
    windowFailure = null;
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
    // reconnect would ever refetch a view again. Note this is a
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
    // pull the moment the socket reconnects -- an armed timer here
    // only costs a wakeup roughly once a minute for nothing.
    if (!stopped && !isOffline() && retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void pull();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    }
  };

  // The queue fires this synchronously on the terminal-rejection path,
  // before the durable poison mark and its public event. A normal recovery
  // lease acquired just before that mark therefore cannot flush its stale
  // pre-mark batch list.
  queue.onPoisonPending?.(() => { authoritativeRepair = "poison"; });

  // A marking round that matched no row leaves nothing for onPoison to
  // trigger a repair from; this is the other half of the claim onPoisonPending
  // took above, and it must release what that claim owns and nothing more.
  queue.onPoisonMarkUnmatched?.(() => {
    if (authoritativeRepair === "poison") {
      authoritativeRepair = null;
      queue.resume("recovery");
    }
  });

  /** Local data now reflects `seq`. A `"snapshot"` always replaced the
   * database; a `"window"` only moved it if the feed had rows to apply, which
   * is exactly when `next_since` advances past the cursor we asked from. */
  const adoptCursor = (seq: SyncSeq, source: "window" | "snapshot"): void => {
    if (source === "snapshot" || seq > cursor) appliedVersion += 1;
    cursor = seq;
    // Whatever window was failing, it is not the one we will ask for next.
    windowFailure = null;
  };

  /** Count this failure against the run of identical ones, and return the new
   * count. Same cursor and same message means the server will hand us the same
   * rows again and the replica will refuse them again; anything else starts a
   * fresh run, because a moving window (or a moving error) is still evidence
   * of progress. */
  const noteWindowFailure = (error: unknown): number => {
    const message = errText(error);
    const run = windowFailure !== null && windowFailure.cursor === cursor &&
      windowFailure.message === message ? windowFailure.count + 1 : 1;
    windowFailure = { cursor, message, count: run };
    return run;
  };

  /** `pending`: the batches the snapshot should say whether it holds. */
  const fetchSnapshot = async (
    pending: readonly PendingBatch[] = [],
  ): Promise<Snapshot> => {
    const query = pendingQuery(pending);
    return (await fetchJson(
      query === "" ? "/api/sync/snapshot" : `/api/sync/snapshot?${query}`,
      undefined, UNTIMED)) as Snapshot;
  };

  /** Batches a payload named as already applied, whose rows the replica
   * dropped instead of replaying: settled as their acks would have settled
   * them. Their deliveries resolve through the queue, and a stored ack that
   * skipped an op bumps resync, as the drain does for a live one. */
  const settleApplied = (
    batches: readonly { batch_id: BatchId; skipped: readonly SkippedOp[] }[],
  ): void => {
    if (batches.length === 0) return;
    if (batches.some((b) => b.skipped.length > 0)) skipped.emit(undefined);
    queue.settleCommitted?.(batches.map((b) => b.batch_id));
  };

  /** `pending`: the rows init read, which a database queued into before its
   * first snapshot can hold. */
  const bootstrap = async (pending: readonly PendingBatch[]): Promise<void> => {
    const snap = await fetchSnapshot(pending);
    await replica.applySnapshot(snap);
    adoptCursor(snap.seq, "snapshot");
    settleApplied(snap.applied_batches ?? []);
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
      // This flush knows nothing about the lane on its own: ask
      // the queue for the same ordering guarantee the drain enforces on
      // itself before posting a batch it pulls. Checked again after, since
      // deliverLaneAhead can take a while and a poison repair may claim
      // recovery during it.
      await queue.deliverLaneAhead?.(b.batch_id);
      beforePost();
      const ack = (await fetchJson("/api/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, batch_id: b.batch_id,
                               ops: b.ops }),
      })) as OpsAck;
      const reading = readOpsAck(ack);
      // This batch committed (skipped ops are not a rejection), same as the
      // lane and the durable drain: the view is told so it can refetch the
      // ghost this batch's skip leaves behind.
      if (reading.skipped.length > 0) {
        skipped.emit(undefined);
      }
      heldAcks.push({ id: b.id, batch_id: b.batch_id, seq: reading.seq ?? null });
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
      // Names no pending batch, unlike a pull or a bootstrap: no leased row
      // can be committed without an ack held in heldAcks, which the commit
      // deletes before its replay. A flushing rebase holds an ack for every
      // row it posted. A poison rebase posts nothing; a row behind the
      // rejected one went out only if a normal flush posted it, and two
      // guards stop that. onPoisonPending claims authoritativeRepair
      // synchronously, before the durable poison mark, so a lease that could
      // see the mark fails assertNormalRecoveryStillOwnsFlush before its
      // first post, and a flush already under way stops at its next one,
      // its acks held. A poisoned row left by an earlier page load is
      // repaired before start() (clientRuntime's startup), before any
      // normal recovery can lease it. Weakening either guard would let a
      // flush post past a poisoned row and this snapshot replay it twice.
      // A reset drops the queue and replays nothing.
      const snapshot = await fetchSnapshot();
      // Every commit takes the held acks. A reset drops the queue, so it
      // passes none; a commit that fails left the rows in place, so the acks
      // go back for the next one.
      const acked = heldAcks;
      heldAcks = [];
      const input: RecoveryCommit = kind === "reset"
        ? { kind: "reset", snapshot }
        : { kind: "rebase", snapshot, acked };
      try {
        await replica.commitRecovery(token, input);
      } catch (error: unknown) {
        heldAcks = [...acked, ...heldAcks];
        throw error;
      }
      token = null; // commit released the worker gate
      adoptCursor(snapshot.seq, "snapshot");
      if (options.forceReadyOnSuccess) {
        started = true;
        noteSuccess({ force: true });
      }
    } catch (error: unknown) {
      const poisonOwnsRecovery = authoritativeRepair === "poison" ||
        error === poisonPreempted;
      // A rebase that hit corruption is about to be retried as a reset by
      // recover(); reporting it here would flash a recovery-failed banner
      // over a repair that is still in progress.
      if (options.reportReplicaFailure && !poisonOwnsRecovery &&
          !wouldEscalateCorruption(kind, error)) {
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
  // synthetic stand-in that always classifies as network-shaped.
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
      if (wouldEscalateCorruption(kind, error)) {
        // A rebase re-applies the snapshot INTO the existing schema, so its
        // `DELETE FROM blocks` runs the same FTS triggers over the same
        // corrupt index and fails the same way. Only a reset (drop and
        // recreate the tables) clears that; runRecovery held its report
        // back for exactly this hand-off (see its catch).
        return rebuildForCorruption(error);
      }
      return { ok: false, error };
    }
  };

  const wouldEscalateCorruption = (
    kind: RecoveryCommit["kind"], error: unknown,
  ): boolean => kind === "rebase" && isFreshCorruption(error, rebuiltForCorruption);

  /** The one automatic rebuild. The budget is spent when a rebuild HAPPENS,
   * not when one is attempted: the snapshot fetch can fail on the same flaky
   * link the corruption arrived on, and a budget burnt there would hand the
   * retry the very stall banner this exists to remove. */
  const rebuildForCorruption = async (
    error: unknown,
  ): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    console.warn(
      "replica: local database is corrupt, rebuilding it from a snapshot",
      error);
    await reportReplicaProblem("replica-corruption", error);
    const result = await recover("reset");
    if (result.ok) rebuiltForCorruption = true;
    return result;
  };

  /** The one automatic rebase for a window nothing local can apply. Same
   * budget rule as rebuildForCorruption -- spent when a rebase HAPPENS -- and
   * `rebase` rather than `reset` because nothing here suggests the schema or
   * the FTS index is bad: a rebase re-snapshots into the existing schema and
   * keeps the pending queue's rows. */
  const rebaseForUnappliableWindow = async (
    error: unknown,
  ): Promise<{ ok: true } | { ok: false; error: unknown } | "deferred"> => {
    console.warn(
      "replica: a changes window will not apply, re-snapshotting past it",
      error);
    // Diagnosis before ownership: the report is the only surviving record of a
    // window nobody has yet explained, and posting it costs nothing if this
    // run then hands recovery over.
    await reportReplicaProblem("window-unappliable", error);
    // Same ownership rule as the corruption branch: a poison repair holds the
    // recovery lease, so leave the window to the pull that follows it.
    if (authoritativeRepair === "poison") return "deferred";
    const result = await recover("rebase");
    if (result.ok) {
      rebasedForUnappliableWindow = true;
      windowFailure = null;
    }
    return result;
  };

  /** What the database says about itself goes to the server log before the
   * repair discards the evidence: the origin of the FTS divergence
   * is still unknown, an unappliable window is by definition unexplained, and
   * after a rebuild nothing is left to inspect. Gathering waits (it needs the
   * pre-repair database); posting does not, and a failure to post is
   * swallowed -- diagnosis never blocks repair. */
  const reportReplicaProblem = async (
    kind: "replica-corruption" | "window-unappliable", error: unknown,
  ): Promise<void> => {
    let report: ReplicaDiagnostics;
    try {
      report = await replica.diagnostics();
    } catch (diagError: unknown) {
      console.warn("replica: could not gather diagnostics", diagError);
      return;
    }
    const body = {
      kind,
      error: errText(error),
      report,
      client: clientInfo(),
    };
    void fetchJson("/api/client/diagnostics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch((postError: unknown) => {
      console.warn("replica: could not post diagnostics", postError);
    });
  };

  const pullLoop = async (): Promise<void> => {
    // Counts consecutive "pending-changed" refetches since the last applied
    // window (including across an `again`-triggered restart). A feed that
    // never stops racing the local queue never applies a window, so a run of
    // them must be treated as a failed pull attempt rather than spin forever;
    // a window that applies is progress, so it clears the run.
    let pendingChangedRetries = 0;
    do {
      again = false;
      let done = false;
      while (!done) {
        let feed: Changes;
        let res: ApplyResult;
        try {
          // One read serves both: the ids named to the server come from the
          // rows this window may drop, so a row queued after it can't be.
          const pending = await replica.pendingBatches();
          const expectedPendingIds = pending.map((batch) => batch.id);
          const query = pendingQuery(pending);
          feed = (await fetchJson(`/api/sync/changes?since=${cursor}` +
            (query === "" ? "" : `&${query}`))) as Changes;
          res = await replica.applyChanges(feed, expectedPendingIds);
        } catch (error: unknown) {
          // Corruption first: it is the one window failure whose repair must
          // be a `reset`, and its own once-per-session budget gates it. A
          // fetch failure is not a ReplicaError and falls through unchanged.
          if (isFreshCorruption(error, rebuiltForCorruption)) {
            // Same ownership rule as the needs-bootstrap branch below: a
            // poison repair holds the recovery lease; leave the corruption
            // for the pull that follows it.
            if (authoritativeRepair === "poison") return;
            const rebuilt = await rebuildForCorruption(error);
            if (!rebuilt.ok) {
              if (authoritativeRepair === "poison") return;
              throw rebuilt.error;
            }
            // The snapshot moved the cursor to its own seq; one more pull
            // confirms nothing landed since and costs an empty window at most.
            continue;
          }
          // Any other refusal of the window itself: apply.ts still throws for
          // everything its needs-bootstrap whitelist does not name, so the
          // decision about a window that keeps throwing lives here. A run of
          // WINDOW_STRIKES identical failures at the same cursor means the
          // feed will keep handing us rows this replica will keep refusing --
          // the shape that used to refetch forever behind the stall banner
          // until a manual "Reset local data".
          if (!isWindowFailure(error) ||
              noteWindowFailure(error) < WINDOW_STRIKES ||
              // The budget is spent: a SECOND run in the same session is a
              // feed bug the user should see, not something to hide behind
              // another resync.
              rebasedForUnappliableWindow) {
            throw error;
          }
          const rebased = await rebaseForUnappliableWindow(error);
          if (rebased === "deferred") return;
          if (!rebased.ok) {
            if (authoritativeRepair === "poison") return;
            throw rebased.error;
          }
          continue;
        }
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
            // isStallShaped classifies it correctly instead of a
            // synthetic stand-in that always looked network-shaped.
            if (authoritativeRepair === "poison") return;
            throw rebased.error;
          }
          done = feed.latest_seq <= cursor;
        } else {
          adoptCursor(res.cursor, "window");
          pendingChangedRetries = 0;
          settleApplied(res.dropped ?? []);
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
      // moment moves to where the commitment actually happens.
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
      await bootstrap(init.pendingBatches);
    }
    started = true;
    // Read by web/tooling/perf/check.mjs to time replica readiness.
    performance.mark?.("pkm:replica-ready");
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
      //
      // Deliberately NOT routed through recover(): corruption met here must
      // not escalate to a reset. A reset drops every table, pending_ops
      // included, and this repair runs with flush "skip" precisely so the
      // later valid rows stay durable until the poisoned one is deleted.
      // The repair banner's Retry, or a reload, is the way out.
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
      // arise once the replica is unavailable).
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
    onSkipped: skipped.add,
  };
}
