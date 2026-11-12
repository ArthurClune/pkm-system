// pattern: Imperative Shell
// Drives the replica from the server (docs/architecture/sync-and-offline.md
// § The changes feed): snapshot bootstrap, nudge-driven windowed pulls, and
// the guarded re-bootstrap paths (feed reset / generation flip /
// schema-version mismatch, docs/architecture/contracts/sync-recovery.md
// § Rebootstrap triggers).
// The guardrail: a re-bootstrap NEVER tears down a database whose pending queue
// is non-empty — queued batches are flushed to the server first (batch_id dedup
// makes replayed flushes safe), and a failed flush keeps the old database:
// degraded beats data loss.

import type { ApiFetchOptions } from "../api/client";
import type { BatchId, SyncSeq } from "../api/brands";
import type { SkippedOp } from "../api/payloads";
import type { ApplyResult, Changes, Snapshot } from "../replica/apply";
import type { ReplicaDiagnostics } from "../replica/client";
import type {
  AckedBatch, PendingBatch, RecoveryCommit, RecoveryLease, Replica, ReplicaInit,
} from "../replica/client";
import { asSessionFatal, isSessionFatal,
         type SessionFatalError } from "../replica/errors";
import { INITIAL_SEQ } from "../ids";
import { coalesce } from "./coalesce";
import type { OpQueue } from "./opQueue";
import { setPlainSpaceTitleCanonicalization } from "./titleCanonicalization";
import { changesOfWire, snapshotOfWire } from "./wire";
import { isFreshCorruption, isStallShaped, isWindowFailure, PullStarvedError } from "./syncFailures";

export type ReplicaState =
  | { mode: "starting" }
  /** No database this session can use: a failed open, a worker that died,
   * or no replica in this environment. Terminal: no other mode follows. */
  | { mode: "no-replica"; error: string }
  | { mode: "ready" }
  | { mode: "recovery-failed"; error: string }
  | { mode: "stalled"; error: string };

export interface ReplicaSync {
  /** Idempotent: first call initializes (+ bootstrap/recovery as needed);
   * later calls catch up the feed. Call on every reconnect. Resolves false
   * when no pull pass served this call: its own pass failed, it was owed
   * behind one that failed (and so never ran), or there is no usable
   * replica. A failed first initialization rejects instead. */
  start(): Promise<boolean>;
  /** WS nudge: pull if the journal moved past our cursor, or unconditionally
   * for a committed metadata/generation frame whose real seq may be equal. */
  onSeq(seq: SyncSeq, force?: boolean): void;
  /** Resolves when no pull is in flight or owed (tests, reconnect
   * ordering). */
  idle(): Promise<void>;
  /** Monotonic count of the moments local data actually moved: a changes
   * window that advanced the cursor, a snapshot bootstrap, or a recovery
   * rebuild. A reconnect that leaves this unchanged has nothing for any view
   * to refetch — which is the common case on a flapping link.
   *
   * `null` means the question cannot be answered: this session has no usable
   * database, so there is no cursor to compare and the caller must assume the
   * worst. noteUnavailable puts it there: the worker's latched failed open,
   * or an RPC client a dead worker left terminal.
   *
   * An ordinary failed pull is deliberately NOT null: the cursor is the durable
   * memory of what has been seen, so a later pull reads the same window
   * again; the caller whose pull failed hears it from start() instead. That
   * reasoning only holds while a later pull can succeed, which a
   * session-fatal error rules out. */
  appliedVersion(): number | null;
  /** True once doStart emits `onState({ mode: "ready" })` (set in the same
   * synchronous step, just before the emit): the local database already has
   * a usable snapshot, whether this call's start() bootstrapped it just now
   * or it was already populated (this session, or persisted from a previous
   * one). False for a mount that has never completed a bootstrap -- the
   * offline-cold-start gap the sync session's first-connect gate closes:
   * a failed start() while offline leaves this false, so the
   * first connect once online still knows to run the reconnect protocol even
   * with an empty durable queue. A failed start() while online is retried
   * on the pull's backoff. Never goes back to false once true. */
  hasStarted(): boolean;
  /** Full-snapshot poison repair under the shared recovery lease. The caller
   * holds the queue's "poison" claim before calling, and nothing here claims
   * or releases it: delivery stays paused on return, so the provider can
   * delete the poison row, bump view resync, and only then resume it. */
  rebaseAuthoritative(reason: "poison"): Promise<void>;
  /** Manual recovery for a wedged replica (incident: pullLoop failures were
   * silently swallowed and the cursor froze). Flushes pending writes (unless
   * discardPending) then rebuilds from a fresh snapshot. Throws
   * ResetBlockedError when discardPending is false and the flush fails. */
  resetLocalData(opts: { discardPending: boolean }): Promise<void>;
  /** The one way into mode no-replica: `error` says this session's
   * database is gone for good. Reports it once; afterwards no mode is
   * reported, no retry is armed and no pass, start or owed pull calls the
   * replica. Called for a session-fatal error met here, by startup discovery,
   * and by the queue when one of its own calls meets one. */
  noteUnavailable(error: SessionFatalError): void;
  /** Stops scheduling backoff retries (of a pull or of a failed start) and
   * clears any pending retry timer. The provider must call this on teardown
   * (unmount) so a stopped instance doesn't leak a timer that outlives its
   * component; an in-flight pull may still finish after stop() but will not
   * reschedule another retry, nor start the pass a nudge owed it. */
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

const POISON_OWNS_RECOVERY = "rejected-batch repair in progress";

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

/** The least time between two renewals of a recovery lease. A renewal is
 * sent only when the run shows progress (a flushed batch's ack, a chunk of
 * the snapshot), so a run that stops advancing stops renewing and the worker
 * frees the gate a lease-length later. */
export const LEASE_RENEW_EVERY_MS = 15_000;
/** How long a snapshot download may go without a byte, its headers included,
 * before it is abandoned. Plus one renewal interval it stays under the lease,
 * so a running client gives the gate back before the worker has to. */
export const SNAPSHOT_STALL_MS = 30_000;

export interface ReplicaSyncDeps {
  replica: Replica;
  /** apiFetch-shaped; typed loosely so tests can hand in plain mocks. */
  fetchJson: (
    path: string, init?: RequestInit, opts?: ApiFetchOptions,
  ) => Promise<unknown>;
  onState: (s: ReplicaState) => void;
  /** Delivery is paused while the worker recovery lease owns the database.
   * The recovery flush posts each leased batch through `deliverLeased`, so
   * it goes out after the lane entries it follows, and every POST and
   * skipped-op signal is the queue's. `onRelease` of "poison" pays the pull
   * a poison repair left owed. A flush without `deliverLeased` throws. */
  queue?: Pick<OpQueue, "pause" | "resume"> &
    Partial<Pick<OpQueue, "onRelease" | "deliverLeased" | "settleCommitted">>;
  /** Whether the queue's barrier holds "poison": a poison repair, or a
   * rejected row still waiting for one, owns recovery, so a normal recovery
   * must neither start nor post past it. Defaults to never. */
  holdsPoison?: () => boolean;
  /** True while the socket is down (mirrors the offline gateway's own
   * `session.status() === "reconnecting"` predicate). A failed pull's retry
   * is pointless here -- every retry while offline just reproduces the same
   * `OfflineError` -- and the reconnect flow already calls `start()` (hence
   * `pull()`) the moment the socket comes back up, so nothing is lost by not
   * arming the timer. Defaults to "never offline" for callers (and tests)
   * that don't track connectivity. */
  isOffline?: () => boolean;
  /** The backoff's first delay; RETRY_BASE_MS unless a harness that cannot
   * fake timers needs a retry to land within one example. */
  retryBaseMs?: number;
  /** LEASE_RENEW_EVERY_MS and SNAPSHOT_STALL_MS unless a harness running a
   * shorter lease scales them with it. */
  recoveryTiming?: { renewEveryMs: number; stallMs: number };
}

/** One recovery run's hold on the worker's lease. */
interface LeaseKeeper {
  /** Called on progress: renews when one is due and none is in flight. */
  renewIfDue: () => void;
  /** Throws the refused renewal's error once one has been refused. */
  assertHeld: () => void;
  /** Waits for the renewal in flight, then asserts the lease is held. */
  settle: () => Promise<void>;
  /** Aborted when a renewal is refused, to stop the snapshot download. */
  signal: AbortSignal;
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
  /** Report mode "recovery-failed" when the run throws. False where the
   * caller owns the report: poison repair and the manual reset each have
   * their own banner, and a stall report over it would contradict them. */
  reportReplicaFailure: boolean;
  /** Wait for a pull that already passed the pending-id guard, and for a
   * start (a retried bootstrap) in flight, before taking the lease: either's
   * stale snapshot or window could otherwise apply after the fresh snapshot
   * and move the cursor/state backwards. Must stay false for recovery that
   * runs *inside* pullLoop or doStart, which would deadlock awaiting the run
   * it is part of. */
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
  const { replica, fetchJson, onState } = deps;
  const queue = deps.queue ?? {
    pause: () => undefined,
    resume: () => undefined,
  };
  const isOffline = deps.isOffline ?? (() => false);
  const holdsPoison = deps.holdsPoison ?? (() => false);
  let cursor = INITIAL_SEQ;
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
  // A pull pass left work to a poison repair; see owePoisonPull.
  let owedAfterPoison = false;
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

  // Stall detection + backoff retry: pullLoop errors used to be
  // swallowed outright, so a wedged replica had zero surfaced symptoms. A run
  // of consecutive failed pull attempts is now reported and retried with
  // growing backoff; `reportedNonReady` avoids re-announcing "ready" on every
  // ordinary successful pull -- only a pull that follows a reported failure
  // needs to clear it.
  const retryBase = deps.retryBaseMs ?? RETRY_BASE_MS;
  const timing = deps.recoveryTiming ??
    { renewEveryMs: LEASE_RENEW_EVERY_MS, stallMs: SNAPSHOT_STALL_MS };
  let consecutiveFailures = 0;
  let retryDelay = retryBase;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let reportedNonReady = false;
  // Set by stop(): a torn-down instance must not leak a timer past unmount,
  // so a still-in-flight pull's eventual noteFailure must not reschedule.
  let stopped = false;

  /** Every report but no-replica's, dropped once the replica is gone: a
   * stalled or recovery-failed banner over it would offer a Reset that
   * cannot work. */
  const setMode = (
    next: Exclude<ReplicaState, { mode: "no-replica" }>,
  ): void => {
    if (usable) onState(next);
  };

  const noteSuccess = (opts: { force?: boolean } = {}): void => {
    consecutiveFailures = 0;
    windowFailure = null;
    retryDelay = retryBase;
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    if (reportedNonReady || opts.force) {
      reportedNonReady = false;
      setMode({ mode: "ready" });
    }
  };

  /** No database this session can use. A worker that died, or that latched
   * its own failed open, rejects every later RPC the same way until a reload,
   * so this is the mode for the rest of the session: appliedVersion() goes
   * null and every reconnect refetches views, the offline gateway stops
   * serving reads from the replica, and offline editing ends. No retry is
   * armed, since none could succeed. */
  const noteUnavailable = (error: SessionFatalError): void => {
    if (!usable) return;
    usable = false;
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    onState({ mode: "no-replica", error: errText(error) });
  };

  /** For a replica call whose error would otherwise be swallowed, or would
   * reach no pass's noteFailure. */
  const noteIfSessionFatal = (error: unknown): void => {
    const fatal = asSessionFatal(error);
    if (fatal !== null) noteUnavailable(fatal);
  };

  /** A failed pull, or a failed start: both retry on one backoff, and both
   * count towards the stall report. The retry runs whichever of the two is
   * still owed. */
  const noteFailure = (error: unknown): void => {
    const fatal = asSessionFatal(error);
    if (fatal !== null) {
      noteUnavailable(fatal);
      return;
    }
    // A pass already under way when the replica went fails for whatever
    // reason it meets: nothing is left to count or retry.
    if (!usable) return;
    if (isStallShaped(error)) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= STALL_AFTER_FAILURES) {
        reportedNonReady = true;
        setMode({ mode: "stalled", error: errText(error) });
      }
    }
    // No timer while offline: every retry would just reproduce the same
    // OfflineError, and the reconnect flow's own start() call resumes the
    // pull the moment the socket reconnects -- an armed timer here
    // only costs a wakeup roughly once a minute for nothing.
    if (!stopped && !isOffline() && retryTimer === null) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (started) void pull();
        // start()'s own catch has already noted the failure
        else void start().catch(() => undefined);
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    }
  };

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

  /** `pending`: the batches the snapshot should say whether it holds.
   * `watch`: a recovery's progress callback and abort signal. The download
   * has no total deadline, since its size grows with the graph and an abort
   * only restarts it, but it is abandoned after `stallMs` of silence. */
  const fetchSnapshot = async (
    pending: readonly PendingBatch[] = [],
    watch?: { onProgress: () => void; signal: AbortSignal },
  ): Promise<Snapshot> => {
    const query = pendingQuery(pending);
    const opts: ApiFetchOptions = { timeoutMs: null, stallMs: timing.stallMs };
    const snapshot = snapshotOfWire(await fetchJson(
      query === "" ? "/api/sync/snapshot" : `/api/sync/snapshot?${query}`,
      watch && { signal: watch.signal },
      watch ? { ...opts, onProgress: watch.onProgress } : opts));
    setPlainSpaceTitleCanonicalization(
      snapshot.plain_space_title_canonicalization);
    return snapshot;
  };

  /** Batches a payload named as already applied, whose rows the replica
   * dropped instead of replaying: the queue settles them as their acks
   * would have, a stored ack's skipped op included. */
  const settleApplied = (
    batches: readonly { batch_id: BatchId; skipped: readonly SkippedOp[] }[],
  ): void => {
    queue.settleCommitted?.(batches);
  };

  /** `pending`: the rows init read, which a database queued into before its
   * first snapshot can hold. */
  const bootstrap = async (pending: readonly PendingBatch[]): Promise<void> => {
    let attempt = pending;
    for (let tries = 1; ; tries += 1) {
      // One read serves both: the ids named to the server are the ids the
      // worker checks the snapshot against.
      const snap = await fetchSnapshot(attempt);
      const res = await replica.applySnapshot(snap, attempt.map((b) => b.id));
      if (res.status === "applied") {
        adoptCursor(snap.seq, "snapshot");
        settleApplied(snap.applied_batches ?? []);
        return;
      }
      // The pending set moved while the snapshot was out (a batch acked
      // before the server's read): the worker refused it untouched.
      if (tries >= PENDING_CHANGED_CAP) {
        throw new PullStarvedError(
          "bootstrap starved: pending batches kept changing");
      }
      attempt = await replica.pendingBatches();
    }
  };

  const assertNormalRecoveryStillOwnsFlush = (): void => {
    if (holdsPoison()) throw poisonPreempted;
  };

  const flushBatches = async (
    batches: PendingBatch[],
    beforePost: () => void,
    afterAck: () => void,
  ): Promise<void> => {
    const deliverLeased = queue.deliverLeased;
    for (const b of batches) {
      // poisoned batches were already rejected by the server; retrying
      // them forever would wedge recovery
      if (b.poisoned) continue;
      beforePost();
      if (deliverLeased === undefined) {
        throw new Error("no queue to deliver a leased batch");
      }
      // beforePost runs again inside, after the lane ahead.
      const reading = await deliverLeased(b, beforePost);
      heldAcks.push({ id: b.id, batch_id: b.batch_id, seq: reading.seq ?? null });
      afterAck();
    }
  };

  const flushLease = async (
    lease: RecoveryLease, policy: FlushPolicy, keeper: LeaseKeeper,
  ): Promise<void> => {
    if (policy === "skip") return;
    if (policy === "preemptible") {
      const beforePost = (): void => {
        assertNormalRecoveryStillOwnsFlush();
        keeper.assertHeld();
      };
      beforePost();
      await flushBatches([...lease.batches], beforePost, keeper.renewIfDue);
      return;
    }
    if (policy === "blocking") {
      try {
        await flushBatches(
          [...lease.batches], keeper.assertHeld, keeper.renewIfDue);
      } catch (cause: unknown) {
        // A lost lease is the run's failure, not a refusal of the flush:
        // asking to discard the queue would not get the lease back.
        keeper.assertHeld();
        // The queue claimed poison on a terminal rejection: the poison repair
        // now owns the row, so asking the user to discard the whole queue
        // would be the wrong question.
        if (holdsPoison()) throw new Error(POISON_OWNS_RECOVERY, { cause });
        throw new ResetBlockedError(
          lease.batches.filter((b) => !b.poisoned).length, { cause },
        );
      }
      return;
    }
    const exhaustive: never = policy;
    throw new Error(`unhandled flush policy: ${String(exhaustive)}`);
  };

  /** Renewal follows progress, never the clock alone: a run that stops
   * advancing (a hung POST, a page that stopped running) stops renewing, so
   * the worker frees the gate a lease-length later. `origin` is read before
   * prepareRecovery is sent, as the lease's first deadline is. */
  const keepLease = (token: string, origin: number): LeaseKeeper => {
    const lost = new AbortController();
    let lastRenewal = origin;
    let renewing: Promise<void> | null = null;
    let refusal: { error: unknown } | null = null;
    const assertHeld = (): void => {
      if (refusal !== null) throw refusal.error;
    };
    return {
      signal: lost.signal,
      assertHeld,
      renewIfDue: () => {
        if (refusal !== null || renewing !== null) return;
        const now = Date.now();
        if (now - lastRenewal < timing.renewEveryMs) return;
        lastRenewal = now;
        renewing = replica.renewRecovery(token).then(() => {
          renewing = null;
        }, (error: unknown) => {
          renewing = null;
          refusal = { error };
          lost.abort();
        });
      },
      settle: async () => {
        await renewing;
        assertHeld();
      },
    };
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
      if (options.awaitInFlightPull) {
        // a failed start is reported by its own catch
        await startOnce.idle();
        await pullRun.idle();
      }
      const origin = Date.now();
      const lease = await replica.prepareRecovery();
      token = lease.token;
      const keeper = keepLease(lease.token, origin);
      // A wait at the gate spent part of the lease: renew now if it was long.
      keeper.renewIfDue();
      await flushLease(lease, options.flush, keeper);
      // Names no pending batch, unlike a pull or a bootstrap: no leased row
      // can be committed without an ack held in heldAcks, which the commit
      // deletes before its replay. A flushing rebase holds an ack for every
      // row it posted. A poison rebase posts nothing; a row behind the
      // rejected one went out only if a normal flush posted it, and two
      // guards stop that. rejectDurableBatch claims "poison" synchronously,
      // before the durable poison mark, so a lease that could see the mark
      // fails assertNormalRecoveryStillOwnsFlush before its first post, and a
      // flush already under way stops at its next one, its acks held. A
      // poisoned row left by an earlier page load is repaired before start()
      // (clientRuntime's startup), before any normal recovery can lease it.
      // Weakening either guard would let a flush post past a poisoned row
      // and this snapshot replay it twice.
      // A reset drops the queue and replays nothing.
      let snapshot: Snapshot;
      try {
        snapshot = await fetchSnapshot(
          [], { onProgress: keeper.renewIfDue, signal: keeper.signal });
      } catch (error: unknown) {
        // a refused renewal aborted the download: report the refusal
        keeper.assertHeld();
        throw error;
      }
      // The commit is refused if a renewal still in flight is.
      await keeper.settle();
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
      if (token !== null) {
        // Commit failures release in the worker; abort is still attempted so
        // transport failures cannot leave a known lease held. Double-token
        // rejection is deliberately ignored in favor of the original error,
        // but a dead worker is not: it ends the mode before any report.
        try {
          await replica.abortRecovery(token);
        } catch (abortError: unknown) {
          noteIfSessionFatal(abortError);
        }
      }
      const poisonOwnsRecovery = holdsPoison() ||
        error === poisonPreempted;
      // A rebase that hit corruption is about to be retried as a reset by
      // recover(); reporting it here would flash a recovery-failed banner
      // over a repair that is still in progress. A session-fatal error is
      // not a failed recovery: it ends the mode here, since a reset or a
      // poison repair calls this directly, with no pass to report it.
      noteIfSessionFatal(error);
      if (options.reportReplicaFailure && !poisonOwnsRecovery &&
          !wouldEscalateCorruption(kind, error) && !isSessionFatal(error)) {
        // Without this, a recovery-failed report that never crosses the
        // stall threshold (e.g. the very first failure) leaves
        // reportedNonReady false, so noteSuccess's later "ready" re-emission
        // is gated off and the banner (plus the stale replicaState it
        // reflects) sticks forever despite a healthy replica.
        reportedNonReady = true;
        setMode({ mode: "recovery-failed", error: errText(error) });
      }
      throw error;
    } finally {
      // Only this run's own claim: a poison repair or an outline lane repair
      // still running holds the barrier under its own owner.
      queue.resume("recovery");
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
        flush: "preemptible", reportReplicaFailure: true,
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
    if (holdsPoison()) return "deferred";
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
      // A pass left to a poison repair ends after this with no further
      // replica call to report the death.
      noteIfSessionFatal(diagError);
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

  /** Work a poison repair now owns is left to it: the pass ends, and one
   * more pull is owed for when the queue releases "poison", since the
   * repair may fail and its snapshot then covers nothing. */
  const owePoisonPull = (): void => { owedAfterPoison = true; };
  const payPoisonPull = (): void => {
    if (!owedAfterPoison || holdsPoison()) return;
    owedAfterPoison = false;
    void pull();
  };
  queue.onRelease?.((owner) => { if (owner === "poison") payPoisonPull(); });

  /** A failed recovery a poison repair now owns is left to that repair,
   * unless its error is session-fatal: that is about the database, not the
   * recovery, so the pass fails with it rather than owing a pull. */
  const leftToPoison = (error: unknown): boolean =>
    holdsPoison() && !isSessionFatal(error);

  const pullLoop = async (): Promise<void> => {
    // Counts consecutive "pending-changed" refetches since the last applied
    // window. A feed that never stops racing the local queue never applies a
    // window, so a run of them must be treated as a failed pull attempt
    // rather than spin forever; a window that applies is progress, so it
    // clears the run.
    let pendingChangedRetries = 0;
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
        feed = changesOfWire(await fetchJson(
          `/api/sync/changes?since=${cursor}` +
          (query === "" ? "" : `&${query}`)));
        setPlainSpaceTitleCanonicalization(
          feed.plain_space_title_canonicalization);
        res = await replica.applyChanges(feed, expectedPendingIds);
      } catch (error: unknown) {
        // Corruption first: it is the one window failure whose repair must
        // be a `reset`, and its own once-per-session budget gates it. A
        // fetch failure is not a ReplicaError and falls through unchanged.
        if (isFreshCorruption(error, rebuiltForCorruption)) {
          // Same ownership rule as the needs-bootstrap branch below: a
          // poison repair holds the recovery lease; leave the corruption
          // for the pull that follows it.
          if (holdsPoison()) { owePoisonPull(); break; }
          const rebuilt = await rebuildForCorruption(error);
          if (!rebuilt.ok) {
            if (leftToPoison(rebuilt.error)) { owePoisonPull(); break; }
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
        if (rebased === "deferred") { owePoisonPull(); break; }
        if (!rebased.ok) {
          if (leftToPoison(rebased.error)) { owePoisonPull(); break; }
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
        // durable row and scheduled resync. Normal recovery would flush
        // later valid rows, breaking poison's stronger ordering.
        if (holdsPoison()) { owePoisonPull(); break; }
        const rebased = await recover("rebase");
        if (!rebased.ok) {
          // A poison signal that arrived mid-recovery (flush-time
          // preemption) is already reported/retried by its own owner and
          // must stay silent here too; any other recovery failure is a
          // genuine failed pull attempt -- rethrow the real error so
          // isStallShaped classifies it correctly instead of a
          // synthetic stand-in that always looked network-shaped.
          if (leftToPoison(rebased.error)) { owePoisonPull(); break; }
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
  };

  // One run is one pass. A pass in flight may be past its fetch, so a call
  // during it never joins: it is owed a run of its own, and a pass that fails
  // drops what it owed to noteFailure's backoff retry, while pull() tells
  // those callers that no pass served them. A pass owed when stop() runs
  // never starts.
  const pullRun = coalesce(async () => {
    if (stopped || !usable) return;
    try {
      await pullLoop();
    } catch (error: unknown) {
      noteFailure(error);
      throw error;
    }
    noteSuccess();
  }, { merge: () => undefined });

  /** True when a pass that could have served this call succeeded. */
  const pull = (): Promise<boolean> => {
    if (!started || !usable) return Promise.resolve(false);
    return pullRun(undefined).then(() => true, () => false);
  };

  const doStart = async (): Promise<boolean> => {
    let init: ReplicaInit;
    try {
      init = await replica.init();
    } catch (error: unknown) {
      // A session-fatal error makes this session online-only: the worker's
      // latched failed open, or a dead worker's terminal RPC client, replays
      // for every later call, so no later start() can revive it. Anything
      // else, a bare timeout included, is an ordinary start failure.
      const fatal = asSessionFatal(error);
      if (fatal !== null) {
        noteUnavailable(fatal);
        return false;
      }
      throw error;
    }
    // Not adoptCursor: this reads the cursor the database already holds, so
    // nothing moved and no view has anything new to fetch.
    cursor = init.cursor;
    setPlainSpaceTitleCanonicalization(init.plainSpaceTitleCanonicalization);
    if (init.schemaMismatch) {
      // deploy changed the DDL: one coordinator flushes and rebuilds under
      // the same worker lease used for feed generation/reset recovery.
      const recovered = await recover("reset");
      if (!recovered.ok) throw recovered.error;
    } else if (init.empty) {
      await bootstrap(init.pendingBatches);
    }
    started = true;
    // Read by web/tooling/perf/check.ts to time replica readiness.
    performance.mark?.("pkm:replica-ready");
    // Clears the failures and any retry a failed start left behind.
    noteSuccess({ force: true });
    return pull();
  };
  // single-flight: the mount-time start (cold start offline needs no
  // socket), the first connect's start and a backoff retry share one
  // initialization. A failed one takes the pull's backoff, so a first
  // bootstrap that failed with the socket up does not wait for the next
  // reconnect, which can be hours away.
  const startOnce = coalesce(async () => {
    try {
      return await doStart();
    } catch (error: unknown) {
      noteFailure(error);
      throw error;
    }
  }, { merge: () => undefined, joinable: () => true });
  const start = async (): Promise<boolean> => {
    if (!usable) return false;
    if (started) return pull();
    return startOnce(undefined);
  };

  return {
    start,
    onSeq(seq, force = false) {
      if (pullRun.running()) {
        // a window is in flight; its server-side latest_seq or metadata may
        // predate this nudge, so ask for one trailing pull instead of dropping
        // it
        void pull();
        return;
      }
      if (!started || (!force && seq <= cursor)) return;
      void pull();
    },
    idle() {
      return pullRun.idle();
    },
    appliedVersion() {
      return usable ? appliedVersion : null;
    },
    hasStarted() {
      return started;
    },
    async rebaseAuthoritative(_reason) {
      // The caller's "poison" claim is what makes a concurrent normal
      // recovery abandon its stale flush; the rest is the shared lifecycle
      // under poison's options (no flush of later valid rows, no report of
      // its own).
      //
      // Deliberately NOT routed through recover(): corruption met here must
      // not escalate to a reset. A reset drops every table, pending_ops
      // included, and this repair runs with flush "skip" precisely so the
      // later valid rows stay durable until the poisoned one is deleted.
      // The repair banner's Retry, or a reload, is the way out.
      await runRecovery("rebase", {
        flush: "skip", reportReplicaFailure: false,
        awaitInFlightPull: true, forceReadyOnSuccess: false,
      });
    },
    async resetLocalData({ discardPending }) {
      // A rejected-batch repair owns recovery until the provider has deleted
      // its durable row and scheduled resync; a manual reset must not steal
      // that lease out from under it (mirrors the needs-bootstrap guard in
      // pullLoop). Bail before touching the queue or acquiring a lease.
      if (holdsPoison()) {
        throw new Error(POISON_OWNS_RECOVERY);
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
        // the session's resetReplica turns this rejection into its own
        // reset-failed banner
        reportReplicaFailure: false,
        awaitInFlightPull: true,
        forceReadyOnSuccess: true,
      });
    },
    noteUnavailable,
    stop() {
      stopped = true;
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    },
  };
}
