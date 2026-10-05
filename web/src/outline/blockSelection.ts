// pattern: Functional Core
// A multi-block selection: a contiguous run of visible blocks, tracked as an
// anchor (where it started) and a head (the moving end). All ordering is read
// off selectableUids so a collapsed subtree's hidden children, and the cells of
// a Roam table (drawn as one grid row during a selection), are never stops.
// Used for "select several blocks and copy their text out".
import type { BlockUid } from "../api/brands";
import type { BlockNode } from "../api/payloads";
import { roamTableRows } from "./roamTableRows";
import { ancestorChain, findNode, selectableUids, selectionRoots } from "./tree";

export interface BlockSelection {
  anchor: BlockUid; // block the selection started on
  head: BlockUid; // the end that Shift+Arrow moves
}

/** A selection begun on `uid`. Inside a valid Roam table (a cell being edited)
 * the anchor is the outermost such table, since the table is one row while
 * selecting. With a direction the head is the anchor's neighbour that way, or
 * the anchor itself at an edge; with null the head is the anchor. */
export function startSelection(
  blocks: BlockNode[], uid: BlockUid, dir: "up" | "down" | null,
): BlockSelection {
  const anchor = ancestorChain(blocks, uid).find((u) => {
    const n = findNode(blocks, u);
    return n !== null && roamTableRows(n) !== null;
  }) ?? uid;
  if (dir === null) return { anchor, head: anchor };
  const order = selectableUids(blocks);
  const i = order.indexOf(anchor);
  const head = i < 0 ? undefined : order[dir === "up" ? i - 1 : i + 1];
  return { anchor, head: head ?? anchor };
}

/** The visible uids the selection covers, in document order (inclusive of both
 * ends). Empty if either end is no longer visible (e.g. a subtree collapsed). */
export function selectedUids(blocks: BlockNode[], sel: BlockSelection): BlockUid[] {
  const order = selectableUids(blocks);
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
  const order = selectableUids(blocks);
  const i = order.indexOf(sel.head);
  if (i < 0) return sel;
  const next = order[dir === "up" ? i - 1 : i + 1];
  return next ? { anchor: sel.anchor, head: next } : sel;
}

/** The selected blocks' text joined with newlines in document order, each
 * line indented with one tab per depth level relative to the shallowest
 * selected block — what lands on the clipboard when the selection
 * is copied, and what parseOutlineForest round-trips back into structure.
 * A selected Roam table brings its whole subtree so it pastes back as a table. */
export function selectionText(blocks: BlockNode[], sel: BlockSelection): string {
  const uids = selectedUids(blocks, sel);
  const depths = new Map<BlockUid, number>();
  const walk = (nodes: BlockNode[], depth: number): void => {
    for (const n of nodes) {
      depths.set(n.uid, depth);
      walk(n.children, depth + 1);
    }
  };
  walk(blocks, 0);
  const base = Math.min(...uids.map((uid) => depths.get(uid) ?? 0));
  const lines: string[] = [];
  const emit = (n: BlockNode, depth: number): void => {
    lines.push("\t".repeat(depth - base) + n.text);
    for (const c of n.children) emit(c, depth + 1);
  };
  for (const uid of uids) {
    const n = findNode(blocks, uid);
    const depth = depths.get(uid) ?? base;
    if (n !== null && roamTableRows(n) !== null) emit(n, depth);
    else lines.push("\t".repeat(depth - base) + (n?.text ?? ""));
  }
  return lines.join("\n");
}

/** The uids a drag should carry when the grab handle is `grabbed`:
 * the selection's root uids in document order when the grabbed block is part
 * of the selection (a selected descendant travels inside its parent), or null
 * when it isn't — that drag is a plain single-block drag. */
export function selectionDragUids(blocks: BlockNode[], sel: BlockSelection,
                                  grabbed: BlockUid): BlockUid[] | null {
  const uids = selectedUids(blocks, sel);
  if (!uids.includes(grabbed)) return null;
  return selectionRoots(blocks, uids);
}

/** Deleting more than this many blocks in one go needs an explicit
 * confirmation — easy to select a large run by accident with Shift+Arrow.
 * The delete is an ordinary undoable history entry, so the bar is set high:
 * the prompt guards against a surprise, not against data loss. */
export const LARGE_DELETE_THRESHOLD = 20;

/** Whether deleting `count` selected blocks should prompt for confirmation
 * before proceeding. */
export function needsDeleteConfirmation(count: number): boolean {
  return count > LARGE_DELETE_THRESHOLD;
}
