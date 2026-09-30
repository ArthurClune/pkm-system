// pattern: Functional Core
// Sync failure classifiers: pure predicates over a thrown error, deciding
// whether it counts toward the stall threshold, is a rejected changes
// window, or is corruption fresh enough to spend the one-per-session rebuild
// budget. replicaSync.ts is the only caller; nothing here does I/O.

import type { ApiError } from "../api/client";
import { availabilityOf, isCorruptionError, ReplicaError } from "../replica/errors";

/** Thrown by pullLoop when the pending-batch id list never stops changing
 * (PENDING_CHANGED_CAP retries exhausted): a real replica-side stall, not a
 * transport hiccup, so noteFailure's classifier must recognize it by type
 * rather than by message text. */
export class PullStarvedError extends Error {}

/** Duck-typed rather than `instanceof ApiError`: this file is Functional
 * Core, and `ApiError` is a class in the Imperative Shell's `api/client.ts`,
 * so a value import of it here would cross the FCIS boundary (see
 * `sync/rejection.ts`'s `isTerminalRejection` for the same move). Only
 * `ApiError` carries a `status` field today, so the duck type is exact. */
const isApiErrorShaped = (error: unknown): error is ApiError =>
  error instanceof Error && "status" in error;

/** `OfflineError` extends `ApiError` with `status` forced to 0 (see
 * `api/client.ts`) -- the only zero an `ApiError` ever carries, since every
 * other constructor call passes a real HTTP status. Duck-typed for the same
 * FCIS-boundary reason as `isApiErrorShaped`. */
const isOfflineErrorShaped = (error: unknown): boolean =>
  isApiErrorShaped(error) && error.status === 0;

/** Network-down failures (dropped connection, DNS, an offline fetch) are not
 * wedged-replica symptoms -- the offline banner already owns network-down
 * UX, and counting them here would flip a whole offline session read-only
 * via computeEditability. A raw `fetch` rejection (`TypeError`) is excluded
 * simply by not matching any branch below; `OfflineError` needs its own
 * check because it extends `ApiError` (status 0, thrown when the offline
 * gateway has no local route for a request) and would otherwise pass the
 * `instanceof ApiError` branch as if the server itself had rejected the call
 * (three offline pulls crossed STALL_AFTER_FAILURES and raised the
 * "Local sync is stuck / Reset local data" banner for a plain network
 * outage). Availability failures are excluded for the same offline-banner
 * reason and more sharply: a session that reports `stalled` on top of
 * `no-replica` is reporting a wedged replica it has already concluded does not
 * exist, and computeEditability would take editing away for the rest of the
 * session. Only failures that mean "the replica itself cannot make
 * progress" -- a rejected/failed API call, a replica-side RPC error, or pull()
 * starving on pending-batch churn -- count toward the stall threshold;
 * anything else still retries with backoff but is neither counted nor reported
 * as stalled. */
export const isStallShaped = (error: unknown): boolean =>
  availabilityOf(error) === null &&
  (error instanceof ReplicaError || error instanceof PullStarvedError ||
    (isApiErrorShaped(error) && !isOfflineErrorShaped(error)));

/** A failure of the window ITSELF: the replica rejected the rows it was given
 * (a NOT NULL/CHECK violation from a malformed feed, a bug in an upsert), so
 * refetching the identical window cannot help. Corruption is excluded because
 * its own branch runs first and takes a different repair; anything with an
 * availability verdict is a statement about the database, not the window; and
 * ApiError/OfflineError/raw fetch rejections are about the transport, where
 * the very next attempt may well succeed.
 *
 * The guarded block also reads `pendingBatches()`, so a replica RPC failure
 * from there counts too. That is deliberate: a snapshot is a valid escape from
 * any of these repeating identically, and one that cannot be taken (a broken
 * RPC answers `prepareRecovery` the same way) fails the recovery and lands on
 * the stall banner anyway. */
export const isWindowFailure = (error: unknown): boolean =>
  error instanceof ReplicaError && availabilityOf(error) === null &&
  !isCorruptionError(error);

/** Corruption this session has not yet rebuilt for. Once per session on
 * purpose: a database that comes back corrupt from a fresh snapshot has a
 * problem a second rebuild will not fix, and that is the point at which
 * the user should see it (as an ordinary stall) rather than a rebuild loop
 * re-downloading the graph forever. */
export const isFreshCorruption = (error: unknown, alreadyRebuilt: boolean): boolean =>
  !alreadyRebuilt && isCorruptionError(error);
