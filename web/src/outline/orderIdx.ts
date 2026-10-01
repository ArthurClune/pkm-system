// pattern: Functional Core
// The one web module that does order-key arithmetic. OrderIdx is a sparse
// sibling order key (blocks.order_idx), not an array position — a delete
// leaves a gap rather than renumbering, so no caller may assume two
// siblings' keys are adjacent. Every place that advances one goes through
// here, so a dense array position can never substitute for an order key by
// accident (tsc catches the swap at the call site instead).
import type { OrderIdx } from "../api/brands";

/** The order key of a page or parent's first-ever child. */
export const FIRST_ORDER_IDX = 0 as OrderIdx;

/** The order key immediately after `o`: where a block inserted right
 * behind it lands. */
export function orderIdxAfter(o: OrderIdx): OrderIdx {
  return (o + 1) as OrderIdx;
}

/** The order key that appends after `siblings`' current last member, or
 * FIRST_ORDER_IDX when there are none. */
export function orderIdxAfterLast(
  siblings: readonly { order_idx: OrderIdx }[],
): OrderIdx {
  const last = siblings[siblings.length - 1];
  return last ? orderIdxAfter(last.order_idx) : FIRST_ORDER_IDX;
}

/** `base` advanced by `n` slots: the key an (n+1)th block in a contiguous
 * multi-block placement lands at, counting from `base` at n=0 — what
 * groupMoveOps and a cross-page drop's per-block surgery both place a run
 * with. `base` must be a real order key of an existing slot (a sibling's
 * `order_idx`, or another helper's output) — never a dense array position —
 * and `n` an offset within a contiguous run being placed at/after it. */
export function orderIdxPlus(base: OrderIdx, n: number): OrderIdx {
  return (base + n) as OrderIdx;
}

/** The order key of the `position`-th child (0-based) of a block created
 * earlier in THIS SAME plan. Valid only there: such a block has no children
 * yet of its own, so its child list is dense from 0, and a fresh subtree
 * pasted or created under it can renumber from 0 without reading any
 * sibling. Not for children of a pre-existing block — use
 * `orderIdxAfterPosition` (or a sibling's own `order_idx`) once real
 * siblings may already occupy those keys. */
export function freshChildOrderIdx(position: number): OrderIdx {
  return position as OrderIdx;
}
