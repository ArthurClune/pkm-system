// pattern: Functional Core
// Undo/redo history for pkm-7q14. invertOps turns a forward op batch into
// the batch that reverses it, computed against the pre-edit tree by
// simulating each op in sequence (via the same applyOps the editor uses, so
// inversion can never disagree with what the ops actually did). set_collapsed
// is view state and is never inverted — EXCEPT that recreating a deleted
// subtree restores collapsed flags, which is content fidelity, not a view
// toggle. A null return means "not invertible from this tree" (e.g. a
// cross-page move); callers record nothing.
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import type { FocusTarget } from "./edits";
import { applyOps, locate, findNode } from "./tree";

export interface HistoryEntry {
  pageTitle: string;
  ops: BlockOp[];       // forward batch (redo replays this)
  inverse: BlockOp[];   // undo batch
  focusBefore: FocusTarget | null;
  focusAfter: FocusTarget | null;
}

export function invertOps(blocks: BlockNode[], pageTitle: string,
                          ops: readonly BlockOp[]): BlockOp[] | null {
  // One inverse GROUP per forward op: groups are reversed as units so a
  // delete's recreate ops keep their parent-before-child internal order.
  const groups: BlockOp[][] = [];
  let tree = blocks;
  for (const op of ops) {
    const group = invertOne(tree, pageTitle, op);
    if (group === null) return null;
    groups.push(group);
    tree = applyOps(tree, [op], pageTitle);
  }
  return groups.reverse().flat();
}

function invertOne(tree: BlockNode[], pageTitle: string,
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
                order_idx: found.node.order_idx }];
    }
    case "delete": {
      const found = locate(tree, op.uid);
      if (!found) return null;
      const creates: BlockOp[] = [];
      const collapses: BlockOp[] = [];
      const walk = (node: BlockNode, parentUid: string | null): void => {
        creates.push({ op: "create", uid: node.uid, page_title: pageTitle,
                       parent_uid: parentUid, order_idx: node.order_idx,
                       text: node.text, heading: node.heading,
                       view_type: node.view_type });
        if (node.collapsed) {
          collapses.push({ op: "set_collapsed", uid: node.uid, collapsed: true });
        }
        for (const child of node.children) walk(child, node.uid);
      };
      walk(found.node, found.parent?.uid ?? null);
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
