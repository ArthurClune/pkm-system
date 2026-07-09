// pattern: Functional Core
// Drop-semantics for block drag-and-drop: which boundaries and depths are
// legal, and what move op a (boundary, depth) resolves to. The DOM shell
// (useDropZone) only measures pixels and calls in here.
import type { BlockNode } from "../api/payloads";
import { applyOps, locate } from "./tree";

export const INDENT_PX = 30; // .block-children: 22px margin-left + 8px padding

export interface DragSource { uid: string; pageTitle: string }
export interface DropTarget {
  parent_uid: string | null;
  order_idx: number;
  page_title: string;
}
export interface DropRow { uid: string; depth: number; collapsed: boolean }

/** On-screen rows (collapsed children hidden), excluding the dragged
 * subtree when the drag comes from this page — boundaries behave as if the
 * block were already lifted out. */
export function dropRows(blocks: BlockNode[], drag: DragSource,
                         pageTitle: string): DropRow[] {
  const out: DropRow[] = [];
  const skipUid = drag.pageTitle === pageTitle ? drag.uid : null;
  const walk = (nodes: BlockNode[], depth: number) => {
    for (const n of nodes) {
      if (n.uid === skipUid) continue;
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
  // When there's no row below (at end of outline), cap max at above's depth
  if (!below && above) max = above.depth;
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
  const walk = (nodes: BlockNode[], parent: string | null) => {
    for (const n of nodes) {
      out.push(`${n.uid}:${parent}`);
      walk(n.children, n.uid);
    }
  };
  walk(blocks, null);
  return out.join("|");
}

/** Resolve (boundary, depth) to a move target. Returns null when the drop
 * would change nothing (same page, same position). */
export function resolveDrop(blocks: BlockNode[], pageTitle: string,
                            drag: DragSource, boundary: number,
                            depth: number): DropTarget | null {
  const rows = dropRows(blocks, drag, pageTitle);
  let parentUid: string | null = null;
  if (depth > 0) {
    for (let i = boundary - 1; i >= 0; i--) {
      if (rows[i].depth === depth - 1) { parentUid = rows[i].uid; break; }
      if (rows[i].depth < depth - 1) return null; // no such parent here
    }
    if (parentUid === null) return null;
  }
  // first row at/after the boundary that is a visible child of parentUid:
  // insert before it. Walk until the parent's subtree region ends.
  let orderIdx: number | null = null;
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
    orderIdx = last ? last.order_idx + 1 : 0;
  }
  const target: DropTarget =
    { parent_uid: parentUid, order_idx: orderIdx, page_title: pageTitle };
  if (drag.pageTitle === pageTitle) {
    const after = applyOps(blocks, [{ op: "move", uid: drag.uid,
      parent_uid: parentUid, order_idx: orderIdx }], pageTitle);
    if (shape(after) === shape(blocks)) return null;
  }
  return target;
}
