// pattern: Functional Core
// Drop-semantics for block drag-and-drop: which boundaries and depths are
// legal, and what move op a (boundary, depth) resolves to. The DOM shell
// (useDropZone) only measures pixels and calls in here.
import type { BlockUid, OrderIdx } from "../api/brands";
import type { BlockNode } from "../api/payloads";
import { groupMoveOps } from "./edits";
import { FIRST_ORDER_IDX, orderIdxAfter } from "./orderIdx";
import { applyOps, locate } from "./tree";

export const INDENT_PX = 30; // .block-children: 22px margin-left + 8px padding

export interface DragSource {
  /** The grabbed block (the drag handle). */
  uid: BlockUid;
  pageTitle: string;
  /** When the grabbed block is part of a multi-block selection, the whole
   * group being dragged: the selection's root uids in document order,
   * including `uid`. Absent for a plain single-block drag. */
  uids?: BlockUid[];
}

/** Every uid a drag carries (the group when present, else the grab handle). */
export function dragUids(drag: DragSource): BlockUid[] {
  return drag.uids ?? [drag.uid];
}
export interface DropTarget {
  parent_uid: BlockUid | null;
  order_idx: OrderIdx;
  page_title: string;
}
export interface DropRow { uid: BlockUid; depth: number; collapsed: boolean }

// The pointer's resolved drop location: which gap among dropRows() (the
// boundary) and which indent level within what that gap allows (the
// depth). The two are always produced and consumed together -- a drag's
// candidate, the indicator it draws, and the move resolveDrop resolves it
// to -- so a named pair keeps a caller from passing them in the wrong order.
export interface DropPosition { boundary: number; depth: number }

/** On-screen rows (collapsed children hidden), excluding every dragged
 * subtree when the drag comes from this page — boundaries behave as if the
 * blocks were already lifted out. */
export function dropRows(blocks: BlockNode[], drag: DragSource,
                         pageTitle: string): DropRow[] {
  const out: DropRow[] = [];
  const skip = drag.pageTitle === pageTitle
    ? new Set(dragUids(drag)) : new Set<BlockUid>();
  const walk = (nodes: BlockNode[], depth: number) => {
    for (const n of nodes) {
      if (skip.has(n.uid)) continue;
      out.push({ uid: n.uid, depth, collapsed: n.collapsed });
      if (!n.collapsed) walk(n.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return out;
}

/** Depths legal at `boundary` (the gap above rows[boundary]; rows.length =
 * after the last row), ascending. A collapsed row above admits no child
 * depth — nothing may land invisibly inside a closed subtree. */
export function allowedDepths(rows: DropRow[], boundary: number): number[] {
  const above = rows[boundary - 1];
  const below = rows[boundary];
  let max = above ? (above.collapsed ? above.depth : above.depth + 1) : 0;
  const min = below ? below.depth : 0;
  const out: number[] = [];
  for (let d = Math.min(min, max); d <= max; d++) out.push(d);
  return out;
}

export function depthFromX(allowed: number[], offsetX: number): number {
  const raw = Math.round(offsetX / INDENT_PX);
  const lo = allowed[0];
  const hi = allowed[allowed.length - 1];
  return Math.max(lo, Math.min(hi, raw));
}

/** uid:parent pairs in depth-first order — the structural fingerprint a
 * same-position drop leaves unchanged. */
function shape(blocks: BlockNode[]): string {
  const out: string[] = [];
  const walk = (nodes: BlockNode[], parent: BlockUid | null) => {
    for (const n of nodes) {
      out.push(`${n.uid}:${parent}`);
      walk(n.children, n.uid);
    }
  };
  walk(blocks, null);
  return out.join("|");
}

/** Resolve a drop position to a move target. Returns null when the drop
 * would change nothing (same page, same position). */
export function resolveDrop(blocks: BlockNode[], pageTitle: string,
                            drag: DragSource,
                            position: DropPosition): DropTarget | null {
  const { boundary, depth } = position;
  const rows = dropRows(blocks, drag, pageTitle);
  let parentUid: BlockUid | null = null;
  if (depth > 0) {
    for (let i = boundary - 1; i >= 0; i--) {
      if (rows[i].depth === depth - 1) { parentUid = rows[i].uid; break; }
      if (rows[i].depth < depth - 1) return null; // no such parent here
    }
    if (parentUid === null) return null;
  }
  // first row at/after the boundary that is a visible child of parentUid:
  // insert before it. Walk until the parent's subtree region ends.
  let orderIdx: OrderIdx | null = null;
  for (let i = boundary; i < rows.length; i++) {
    if (rows[i].depth < depth) break;      // left the parent's region
    if (rows[i].depth === depth) {
      const loc = locate(blocks, rows[i].uid);
      orderIdx = loc ? loc.node.order_idx : null;
      break;
    }
  }
  if (orderIdx === null) {
    const siblings = parentUid === null
      ? blocks : locate(blocks, parentUid)?.node.children ?? [];
    const last = siblings[siblings.length - 1];
    orderIdx = last ? orderIdxAfter(last.order_idx) : FIRST_ORDER_IDX;
  }
  const target: DropTarget =
    { parent_uid: parentUid, order_idx: orderIdx, page_title: pageTitle };
  if (drag.pageTitle === pageTitle) {
    const after = applyOps(
      blocks, groupMoveOps(dragUids(drag), parentUid, orderIdx), pageTitle);
    if (shape(after) === shape(blocks)) return null;
  }
  return target;
}
