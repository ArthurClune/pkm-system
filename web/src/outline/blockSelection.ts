// pattern: Functional Core
// A multi-block selection: a contiguous run of visible blocks, tracked as an
// anchor (where it started) and a head (the moving end). All ordering is read
// off visibleUids so a collapsed subtree's hidden children are never part of a
// selection. Used for "select several blocks and copy their text out".
import type { BlockNode } from "../api/payloads";
import { findNode, visibleUids } from "./tree";

export interface BlockSelection {
  anchor: string; // block the selection started on
  head: string; // the end that Shift+Arrow moves
}

/** The visible uids the selection covers, in document order (inclusive of both
 * ends). Empty if either end is no longer visible (e.g. a subtree collapsed). */
export function selectedUids(blocks: BlockNode[], sel: BlockSelection): string[] {
  const order = visibleUids(blocks);
  const a = order.indexOf(sel.anchor);
  const h = order.indexOf(sel.head);
  if (a < 0 || h < 0) return [];
  const [lo, hi] = a <= h ? [a, h] : [h, a];
  return order.slice(lo, hi + 1);
}

/** Move the head one visible block up/down, keeping the anchor fixed. Returns
 * the selection unchanged when the head is already at the top/bottom edge. */
export function extendSelection(
  blocks: BlockNode[], sel: BlockSelection, dir: "up" | "down",
): BlockSelection {
  const order = visibleUids(blocks);
  const i = order.indexOf(sel.head);
  if (i < 0) return sel;
  const next = order[dir === "up" ? i - 1 : i + 1];
  return next ? { anchor: sel.anchor, head: next } : sel;
}

/** The selected blocks' text joined with newlines in document order — what
 * lands on the clipboard when the selection is copied. */
export function selectionText(blocks: BlockNode[], sel: BlockSelection): string {
  return selectedUids(blocks, sel)
    .map((uid) => findNode(blocks, uid)?.text ?? "")
    .join("\n");
}
