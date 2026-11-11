// pattern: Functional Core
// The Link click lifecycle, written from the table in the header of
// components/unlinkedStatus.ts and never from withStatus: which move from
// which status is allowed, and which statuses hide a block.

/** A block's status: "none" before any click, "error a" and "error b" two
 * different failure messages. */
export type ModelStatus = "none" | "pending" | "settled" | "delivered" | "error a" | "error b";

const isError = (s: ModelStatus): boolean => s === "error a" || s === "error b";

/** The moves the table lists, by what they move from. */
export function allowed(from: ModelStatus, to: ModelStatus): boolean {
  if (from === "delivered") return false;
  if (isError(to)) return true;
  switch (to) {
    case "pending": return from === "none" || isError(from);
    case "settled": return from === "pending";
    case "delivered": return from === "settled";
    default: return false;
  }
}

/** The status after an attempted move: a refused or repeated move leaves it. */
export function moved(from: ModelStatus, to: ModelStatus): ModelStatus {
  return allowed(from, to) ? to : from;
}

/** A click may start a link. */
export function linkable(s: ModelStatus): boolean {
  return s === "none" || isError(s);
}

/** The block shows in the list. */
export function listed(s: ModelStatus): boolean {
  return s !== "settled" && s !== "delivered";
}
