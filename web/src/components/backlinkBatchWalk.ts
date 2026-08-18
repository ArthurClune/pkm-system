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
