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
 * with. */
export function orderIdxPlus(base: OrderIdx, n: number): OrderIdx {
  return (base + n) as OrderIdx;
}
