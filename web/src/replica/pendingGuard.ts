// pattern: Functional Core
// Whether a sync window fetched against one pending-batch snapshot may still
// be applied now that the pending set has moved on.
//
// The guard exists because a window the server generated BEFORE batch B
// committed lacks B, and if B's ack deleted its pending row before the window
// was applied, applying it with B no longer pending to replay would drop B's
// optimistic edit (the head window's rewind takes B's records back to their
// pre-images). So a pending set that lost B is only unsafe when the window
// might predate B's server commit. B need not be in the snapshot: a batch
// queued after the pull read its ids, then acked during the fetch, leaves the
// pending set unchanged, so every recorded ack is checked, not just the
// removed rows'.
//
// The ack of POST /api/ops names the journal max as of B's commit, and
// /api/sync/changes reads latest_seq in the same read snapshot as the window
// rows. latest_seq >= B's acked seq therefore means the window (with its
// continuation pages) already carries B -- the same guarantee a refetch would
// give. pending_ops ids are AUTOINCREMENT, so a removed id never comes back as
// a different batch.

import type { SyncSeq } from "../api/brands";
import type { PendingRowId } from "./client";

/**
 * True when `current` is `expected` with zero or more ids removed (order
 * preserved), every removed id has an acked seq in `ackedSeqs`, and the
 * window's `latestSeq` has reached every seq in `ackedSeqs`. Any addition,
 * reorder, removal of a batch whose commit seq is unknown, or ack beyond the
 * window is not covered: the caller refetches.
 */
export function pendingSetStillCovered(
  expected: readonly PendingRowId[],
  current: readonly PendingRowId[],
  ackedSeqs: ReadonlyMap<PendingRowId, SyncSeq>,
  latestSeq: SyncSeq,
): boolean {
  for (const acked of ackedSeqs.values()) {
    if (acked > latestSeq) return false;
  }
  let at = 0;
  for (const id of expected) {
    if (at < current.length && current[at] === id) {
      at += 1;
      continue;
    }
    if (!ackedSeqs.has(id)) return false;
  }
  return at === current.length;
}
