// pattern: Functional Core
import type { BacklinkGroup, BlockRefText } from "../api/payloads";
import { mergeGroups } from "./groups";

/** groups, total page count, and extra reference texts change in lockstep --
 * one value so a partial update (e.g. groups without a matching totalPages)
 * can't happen. */
export type BacklinkBatchState = {
  groups: BacklinkGroup[];
  totalPages: number;
  refTexts: Record<string, BlockRefText>;
};

/** The slice of a page-payload response the walk consumes. */
export type BacklinkBatchPayload = {
  backlinks: { groups: BacklinkGroup[]; total_pages: number };
  block_ref_texts: Record<string, BlockRefText>;
};

export type FetchBacklinkBatch =
  (offset: number, limit: number) => Promise<BacklinkBatchPayload>;

/** Given the state accumulated so far and how many batches this walk has
 * already fetched, return the limit for the next batch, or null to stop. */
export type NextBatchLimit =
  (state: BacklinkBatchState, batchesFetched: number) => number | null;

/**
 * Fetch successive backlink batches -- offset is always `state.groups.length`
 * -- until `nextLimit` says to stop, a batch comes back with zero groups, or
 * a batch produces no new distinct group (the server's reported total can
 * lag reality; treat that as "caught up" rather than looping forever).
 *
 * `isStale` is polled immediately after every await, before that batch's
 * data is merged in, so a caller superseded by a newer request (e.g. a
 * fresher refresh epoch) discards the batch instead of committing it: the
 * walk resolves to the literal `"stale"` and touches nothing else.
 *
 * `nextLimit` alone expresses every caller's shape: a single fixed-size
 * batch (show more), a full loop to completion (loading everything for the
 * filter panel), or a variable-size first batch followed by a loop (refresh
 * with the filter panel open).
 */
export async function walkBacklinkBatches(
  fetchBatch: FetchBacklinkBatch,
  state: BacklinkBatchState,
  nextLimit: NextBatchLimit,
  isStale: () => boolean,
): Promise<BacklinkBatchState | "stale"> {
  let current = state;
  let batchesFetched = 0;
  let limit = nextLimit(current, batchesFetched);
  while (limit !== null) {
    const payload = await fetchBatch(current.groups.length, limit);
    if (isStale()) return "stale";
    batchesFetched += 1;
    const totalPages = payload.backlinks.total_pages;
    const refTexts = { ...current.refTexts, ...payload.block_ref_texts };
    if (payload.backlinks.groups.length === 0) {
      return { ...current, totalPages, refTexts };
    }
    const groups = mergeGroups(current.groups, payload.backlinks.groups);
    if (groups.length === current.groups.length) {
      return { groups, totalPages, refTexts };
    }
    current = { groups, totalPages, refTexts };
    limit = nextLimit(current, batchesFetched);
  }
  return current;
}

/**
 * Merge a walk's result onto the latest state rather than replacing it
 * outright. `loadMore` and `loadAll` each start their walk from a snapshot
 * of state taken before any await and guard only against a concurrent
 * refresh (via `isStale`), not against each other -- so both can be in
 * flight at once, and whichever settles last must not discard the other's
 * progress. `mergeGroups` dedupes by page_id/uid, so merging is commutative
 * and idempotent: applying either order, or re-applying a batch the other
 * caller already folded in, converges to the same union.
 *
 * `refresh` does not use this -- it replaces wholesale, because dropping a
 * group that no longer exists server-side is the whole point of a refresh,
 * and a merge can only ever add.
 */
export function mergeBacklinkResult(
  current: BacklinkBatchState, result: BacklinkBatchState,
): BacklinkBatchState {
  return {
    groups: mergeGroups(current.groups, result.groups),
    totalPages: result.totalPages,
    refTexts: { ...current.refTexts, ...result.refTexts },
  };
}
