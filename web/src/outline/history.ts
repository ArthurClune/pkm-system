// pattern: Functional Core
// Undo/redo history. invertOps turns a forward op batch into
// the batch that reverses it, computed against the pre-edit tree by
// simulating each op in sequence (via the same applyOps the editor uses, so
// inversion can never disagree with what the ops actually did). set_collapsed
// is view state and is never inverted — EXCEPT that recreating a deleted
// subtree restores collapsed flags, which is content fidelity, not a view
// toggle. A null return means "not invertible from this tree" (e.g. a
// cross-page move); callers record nothing.
//
// A placement (create, move) shifts every sibling at or after its key up, and
// nothing shifts keys down, so a replayed batch can restore positions but not
// keys: after any undo, and after any other device's edit, a recorded
// order_idx may name a different slot than it did. Two rules follow.
// - Within a batch, invertOps plans each op's inverse against the tree the
//   inverses replayed before it leave, newest op first.
// - Across replays, a placement's key is never trusted on its own. Each one
//   records its anchor: the sibling it landed directly in front of, or "last"
//   when it landed after every sibling. Replay re-keys it against the live
//   tree to land in front of that same sibling (resolveAnchors), keeping the
//   recorded key when it already does. When the anchor has left the parent
//   (deleted, moved elsewhere), the recorded key stands. Anchoring on the
//   following sibling matches the op's own contract, which inserts in front
//   of whatever holds its key, so blocks another device added meanwhile stay
//   where that device put them, relative to their own neighbours.
import type { BlockUid, OrderIdx } from "../api/brands";
import type { BlockNode } from "../api/payloads";
import type { BlockOp, CreateOp, MoveOp } from "../api/ops";
import type { FocusTarget } from "./edits";
import { orderIdxAfter, orderIdxAfterLast } from "./orderIdx";
import { applyOpInPlace, applyOps, cloneTree, locate, findNode,
         type Located } from "./tree";

/** Where a placement put its block, read off the tree it was applied to:
 * directly in front of the sibling `before`, or after every sibling (null). */
export interface PlacementAnchor { before: BlockUid | null }

/** One slot per op of a batch. A null or missing slot is not a placement on
 * this page, and replays as recorded. */
export type BatchAnchors = readonly (PlacementAnchor | null)[];

export interface HistoryEntry {
  pageTitle: string;
  ops: BlockOp[];       // forward batch (redo replays this)
  inverse: BlockOp[];   // undo batch
  /** `ops` anchored on the pre-edit tree, `inverse` on the tree `ops` left. */
  anchors: { ops: BatchAnchors; inverse: BatchAnchors };
  focusBefore: FocusTarget | null;
  focusAfter: FocusTarget | null;
}

/** The siblings a create or move would land among on this page, the placed
 * block itself left out; null when the op places nothing in this tree. */
function placementSiblings(tree: BlockNode[], pageTitle: string,
                           op: CreateOp | MoveOp): BlockNode[] | null {
  if (op.op === "create" ? op.page_title !== pageTitle
      : (op.page_title != null && op.page_title !== pageTitle)
        || !locate(tree, op.uid)) {
    return null;
  }
  const parentUid = op.parent_uid ?? null;
  const siblings = parentUid === null ? tree : findNode(tree, parentUid)?.children;
  return siblings ? siblings.filter((s) => s.uid !== op.uid) : null;
}

const isPlacement = (op: BlockOp): op is CreateOp | MoveOp =>
  op.op === "create" || op.op === "move";

/** Anchors `ops` while applying them to `tree`, which this mutates. A
 * placement lands in front of the first sibling at or past its key. */
function anchorBatch(tree: BlockNode[], pageTitle: string,
                     ops: readonly BlockOp[]): (PlacementAnchor | null)[] {
  return ops.map((op) => {
    let anchor: PlacementAnchor | null = null;
    if (isPlacement(op)) {
      const siblings = placementSiblings(tree, pageTitle, op);
      if (siblings) {
        anchor = { before: siblings.find((s) => s.order_idx >= op.order_idx)?.uid ?? null };
      }
    }
    applyOpInPlace(tree, op, pageTitle);
    return anchor;
  });
}

/** The anchors a history entry records: `ops` read off `pre`, `inverse` off
 * the tree `ops` leave. A batch with no placement (typing, a heading) clones
 * nothing. */
export function historyAnchors(pre: BlockNode[], pageTitle: string,
                               ops: readonly BlockOp[],
                               inverse: readonly BlockOp[]): HistoryEntry["anchors"] {
  if (!ops.some(isPlacement) && !inverse.some(isPlacement)) {
    return { ops: ops.map(() => null), inverse: inverse.map(() => null) };
  }
  const tree = cloneTree(pre);
  const forward = anchorBatch(tree, pageTitle, ops);
  return { ops: forward, inverse: anchorBatch(tree, pageTitle, inverse) };
}

/** `batch` re-keyed to replay onto `live`: each anchored placement lands in
 * front of its anchor (or last), keeping its recorded key when that already
 * does, and keeping it too when the anchor is no longer among the target
 * parent's children. Ops are re-keyed in sequence, each against the tree the
 * ones before it leave. */
export function resolveAnchors(live: BlockNode[], pageTitle: string,
                               batch: readonly BlockOp[],
                               anchors: BatchAnchors): BlockOp[] {
  if (!anchors.some((a) => a)) return [...batch];
  const tree = cloneTree(live);
  return batch.map((op, i) => {
    const resolved = anchoredOp(tree, pageTitle, op, anchors[i] ?? null);
    applyOpInPlace(tree, resolved, pageTitle);
    return resolved;
  });
}

function anchoredOp(tree: BlockNode[], pageTitle: string, op: BlockOp,
                    anchor: PlacementAnchor | null): BlockOp {
  if (anchor === null || !isPlacement(op)) return op;
  const siblings = placementSiblings(tree, pageTitle, op);
  if (siblings === null) return op;
  const at = anchor.before === null
    ? siblings.length : siblings.findIndex((s) => s.uid === anchor.before);
  if (at < 0) return op;
  const prev = siblings[at - 1];
  const next = siblings[at];
  if ((!prev || prev.order_idx < op.order_idx)
      && (!next || op.order_idx <= next.order_idx)) {
    return op;
  }
  return { ...op, order_idx: next ? next.order_idx : orderIdxAfterLast(siblings) };
}

export function invertOps(blocks: BlockNode[], pageTitle: string,
                          ops: readonly BlockOp[]): BlockOp[] | null {
  // One inverse GROUP per forward op, newest op's group first: groups are
  // reversed as units so a delete's recreate ops keep their
  // parent-before-child internal order. Undo applies them in that order, so
  // each group is planned against the tree the groups before it leave.
  const trees = [blocks];
  for (const op of ops.slice(0, -1)) {
    trees.push(applyOps(trees[trees.length - 1], [op], pageTitle));
  }
  let undone = ops.length > 0
    ? applyOps(trees[trees.length - 1], [ops[ops.length - 1]], pageTitle)
    : blocks;
  const groups: BlockOp[][] = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const group = invertOne(trees[i], undone, pageTitle, ops[i]);
    if (group === null) return null;
    groups.push(group);
    if (i > 0) undone = applyOps(undone, group, pageTitle);
  }
  return groups.flat();
}

/** The order_idx that puts `found`'s block back right after the previous
 * sibling it had where it was found, placed into `now`. Its old key when that still lies past
 * the previous sibling, so an undo that disturbed nothing restores keys
 * exactly; otherwise a shift moved that sibling onto or past the old key, and
 * the old key would land the block in front of it. Keys only ever shift up,
 * so the old next sibling still sits at or past whichever key this picks. */
function restoredOrderIdx(now: BlockNode[], found: Located): OrderIdx {
  const prev = found.siblings[found.index - 1];
  const prevNow = prev ? findNode(now, prev.uid) : null;
  const oldKey = found.node.order_idx;
  return prevNow && prevNow.order_idx >= oldKey
    ? orderIdxAfter(prevNow.order_idx) : oldKey;
}

/** `tree` is the forward op's input; `now` is the tree its inverse will be
 * applied to — position-equal to the op's output, keys possibly shifted. */
function invertOne(tree: BlockNode[], now: BlockNode[], pageTitle: string,
                   op: BlockOp): BlockOp[] | null {
  switch (op.op) {
    case "create_page":
      return []; // additive and harmless; nothing to undo
    case "set_collapsed":
      return []; // view state: never undone (spec)
    case "create":
      return op.page_title === pageTitle
        ? [{ op: "delete", uid: op.uid }] : null;
    case "update_text": {
      const node = findNode(tree, op.uid);
      return node ? [{ op: "update_text", uid: op.uid, text: node.text }] : null;
    }
    case "set_heading": {
      const node = findNode(tree, op.uid);
      return node
        ? [{ op: "set_heading", uid: op.uid, heading: node.heading }] : null;
    }
    case "set_view_type": {
      const node = findNode(tree, op.uid);
      // view_type null means "default"; the op can't express null, so restore
      // the effective default — renders identically.
      return node ? [{ op: "set_view_type", uid: op.uid,
                       view_type: node.view_type ?? "document" }] : null;
    }
    case "move": {
      if (op.page_title != null && op.page_title !== pageTitle) return null;
      const found = locate(tree, op.uid);
      if (!found) return null; // arriving from another page: not invertible here
      return [{ op: "move", uid: op.uid,
                parent_uid: found.parent?.uid ?? null,
                order_idx: restoredOrderIdx(now, found) }];
    }
    case "delete": {
      const found = locate(tree, op.uid);
      if (!found) return null;
      const creates: BlockOp[] = [];
      const collapses: BlockOp[] = [];
      // only the root lands among existing siblings; the rest are recreated
      // into parents this group creates, so their own keys are free
      const walk = (node: BlockNode, parentUid: BlockUid | null,
                    orderIdx: OrderIdx): void => {
        creates.push({ op: "create", uid: node.uid, page_title: pageTitle,
                       parent_uid: parentUid, order_idx: orderIdx,
                       text: node.text, heading: node.heading,
                       view_type: node.view_type });
        if (node.collapsed) {
          collapses.push({ op: "set_collapsed", uid: node.uid, collapsed: true });
        }
        for (const child of node.children) {
          walk(child, node.uid, child.order_idx);
        }
      };
      walk(found.node, found.parent?.uid ?? null, restoredOrderIdx(now, found));
      return [...creates, ...collapses];
    }
  }
}

export interface HistoryState {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

export const HISTORY_CAP = 100;

export function emptyHistory(): HistoryState {
  return { undo: [], redo: [] };
}

export function recordEntry(state: HistoryState,
                            entry: HistoryEntry): HistoryState {
  return { undo: [...state.undo, entry].slice(-HISTORY_CAP), redo: [] };
}

export function takeUndo(state: HistoryState):
    { state: HistoryState; entry: HistoryEntry | null } {
  const entry = state.undo[state.undo.length - 1] ?? null;
  if (!entry) return { state, entry: null };
  return {
    state: { undo: state.undo.slice(0, -1), redo: [...state.redo, entry] },
    entry,
  };
}

export function takeRedo(state: HistoryState):
    { state: HistoryState; entry: HistoryEntry | null } {
  const entry = state.redo[state.redo.length - 1] ?? null;
  if (!entry) return { state, entry: null };
  return {
    state: { undo: [...state.undo, entry], redo: state.redo.slice(0, -1) },
    entry,
  };
}
