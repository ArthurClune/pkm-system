// pattern: Functional Core
// The op queue's in-memory lane as a value: the entries retained when the
// replica could not persist an enqueue, and the ordering rules that decide
// when a lane entry must be delivered before a durable batch. The queue
// shell owns the delivery promises and the POSTs; this module only decides.
import type { BlockOp } from "../api/ops";

export interface LaneEntry {
  /** Minted once, at append time: a retry must re-POST a byte-identical
   * payload under the same id, since the server binds batch_id to a
   * sha256 of the ops. */
  readonly batchId: string;
  readonly ops: BlockOp[];
  /** This entry's position in lane-append order, assigned once at append
   * time from `appended`. Compared against a durable batch's boundary in
   * `follows` to decide whether that batch may overtake it (see
   * headPrecedes) — ordering by identity, never by a count. Named
   * `laneSeq`, not `seq`: this is a purely local append counter, never the
   * server's `SyncSeq`. */
  readonly laneSeq: number;
}

export interface OutboxState {
  readonly entries: readonly LaneEntry[];
  /** Monotonic count of lane entries ever appended: the source of each
   * entry's `seq` and of the boundary a durable batch's `follows` mark
   * records. */
  readonly appended: number;
  /** batch_id -> the lane-append boundary that batch must wait behind: every
   * entry whose `seq` is less than this value was appended to the lane
   * before this durable batch was persisted, so it must be delivered first.
   * Only set for a durable batch the queue persisted while the lane was
   * non-empty (see markFollows) — a durable row with no entry here (a
   * previous session's rows, the offline shim's create_page in
   * replica/localApi/router.ts) is ahead of the lane by default, since
   * headPrecedes treats a missing mark as a boundary of -1. A mark is
   * removed once its batch is delivered or rejected (forget), and the whole
   * map is cleared once the lane empties (settleHead) or nextBatch()
   * observes the durable queue empty (clearMarks), which catches batches
   * flushed out of band. */
  readonly follows: ReadonlyMap<string, number>;
}

export function createOutbox(): OutboxState {
  return { entries: [], appended: 0, follows: new Map() };
}

/** Retain ops at the tail of the lane under the next `seq`. Any durable batch
 * already persisted is simply unmarked in `follows`, which headPrecedes
 * treats as ahead of this entry regardless. */
export function append(
  s: OutboxState, batchId: string, ops: BlockOp[],
): OutboxState {
  return {
    ...s,
    entries: [...s.entries, { batchId, ops, laneSeq: s.appended }],
    appended: s.appended + 1,
  };
}

/** A durable batch persisted while the lane still holds entries: every one
 * of them was appended before this batch existed, so it follows all of
 * them. Nothing to mark when the lane is empty — there is nothing for this
 * batch to wait behind. */
export function markFollows(s: OutboxState, batchId: string): OutboxState {
  if (s.entries.length === 0) return s;
  const follows = new Map(s.follows);
  follows.set(batchId, s.appended);
  return { ...s, follows };
}

export function laneHead(s: OutboxState): LaneEntry | undefined {
  return s.entries[0];
}

/** True exactly when the lane head must be delivered before `batchId` may
 * itself go out. `batchId === null` means nextBatch() observed the durable
 * queue empty, so any lane head qualifies outright — there is nothing left
 * for it to wait behind. Otherwise a durable batch the queue never marked
 * (see `follows`) is ahead of the lane by construction: the lookup's `-1`
 * default can never exceed a real (non-negative) seq. This is the ONE
 * predicate both the drain and deliverLaneAhead consult — ordering is
 * decided here, once, by batch identity. */
export function headPrecedes(
  s: OutboxState, batchId: string | null,
): boolean {
  const head = s.entries[0];
  if (head === undefined) return false;
  if (batchId === null) return true;
  return head.laneSeq < (s.follows.get(batchId) ?? -1);
}

/** Shift the lane head out ONLY if it is still the entry named `batchId`.
 * The drain and the recovery flush (replicaSync.flushBatches, via
 * deliverLaneAhead) may race delivering the very same head: a duplicate POST
 * of the same batch_id is a harmless server replay, but a double shift
 * would drop the entry behind it instead of settling this one twice.
 * Clearing `follows` here (rather than per removed mark) is what keeps an
 * emptied lane from leaving a boundary behind for the next entry appended
 * to inherit. */
export function settleHead(s: OutboxState, batchId: string): OutboxState {
  if (s.entries[0]?.batchId !== batchId) return s;
  const entries = s.entries.slice(1);
  return {
    ...s,
    entries,
    follows: entries.length === 0 ? new Map() : s.follows,
  };
}

/** This durable batch was delivered or rejected, so its mark (if it had
 * one) no longer needs to hold any lane head behind it. */
export function forget(s: OutboxState, batchId: string): OutboxState {
  if (!s.follows.has(batchId)) return s;
  const follows = new Map(s.follows);
  follows.delete(batchId);
  return { ...s, follows };
}

/** Nothing durable is left, so no mark can still be waiting on a real
 * predecessor. */
export function clearMarks(s: OutboxState): OutboxState {
  return { ...s, follows: new Map() };
}
