// pattern: Functional Core
// Where each Link click in Unlinked references stands, one status per block:
//
//   none or error -> pending     a click
//   none or error -> error       no safe match, or a text over its limit
//   pending       -> settled     the ticket settles (durable locally)
//   pending       -> error       queueing throws or the settle fails
//   settled       -> delivered   the server applied the write
//   settled       -> error       delivery fails; the block shows again
//
// A settled block is hidden, but the server may still list it, so it counts
// out of the shown total and the next offset. A delivered block has left the
// server's list; the section drops it from the loaded groups and the total,
// and its status stays so that a batch answered before the link landed
// cannot bring it back.
import type { BlockUid } from "../api/brands";
import type { BlockGroup } from "../api/payloads";

export type LinkStatus =
  | "pending" | "settled" | "delivered" | { readonly error: string };
export type LinkStatuses = ReadonlyMap<BlockUid, LinkStatus>;

function isError(
  status: LinkStatus | undefined,
): status is { readonly error: string } {
  return typeof status === "object";
}

/** A click may start a link: nothing in flight, nothing delivered. */
export function canLink(status: LinkStatus | undefined): boolean {
  return status === undefined || isError(status);
}

/** The block shows in the list. */
export function isListed(status: LinkStatus | undefined): boolean {
  return status !== "settled" && status !== "delivered";
}

function allowed(from: LinkStatus | undefined, to: LinkStatus): boolean {
  if (isError(to)) return from !== "delivered";
  switch (to) {
    case "pending": return canLink(from);
    case "settled": return from === "pending";
    case "delivered": return from === "settled";
  }
}

function same(a: LinkStatus | undefined, b: LinkStatus): boolean {
  return a === b || (isError(a) && isError(b) && a.error === b.error);
}

/** `statuses` with `uid` moved to `status`; the same map when the move is
 * not one the lifecycle allows or changes nothing. */
export function withStatus(
  statuses: LinkStatuses, uid: BlockUid, status: LinkStatus,
): LinkStatuses {
  const from = statuses.get(uid);
  if (same(from, status) || !allowed(from, status)) return statuses;
  return new Map(statuses).set(uid, status);
}

export function settledCount(statuses: LinkStatuses): number {
  let n = 0;
  for (const status of statuses.values()) if (status === "settled") n += 1;
  return n;
}

/** A fetched batch without the blocks whose links were delivered. */
export function withoutDelivered(
  groups: readonly BlockGroup[], statuses: LinkStatuses,
): BlockGroup[] {
  return groups.map((g) => ({
    ...g,
    items: g.items.filter((item) => statuses.get(item.uid) !== "delivered"),
  }));
}

/** /api/unlinked pages by blocks. A settled block may still be listed:
 * counting it out can only re-fetch a block mergeGroups drops, where
 * counting it in could skip one. A delivered block is already out of
 * `loadedCount`. */
export function nextOffset(loadedCount: number, statuses: LinkStatuses): number {
  return loadedCount - settledCount(statuses);
}
