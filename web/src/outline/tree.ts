// pattern: Functional Core
// Pure helpers over the page block tree: lookup, on-screen order, and
// applying committed op semantics so local state mirrors the server's
// ops_apply.py exactly. ShiftSiblings leaves order_idx gaps on the server;
// everything here keys on order_idx VALUES, never array positions.
import type { BlockUid, OrderIdx } from "../api/brands";
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import { orderIdxAfter } from "./orderIdx";

export interface Located {
  node: BlockNode;
  parent: BlockNode | null; // null = top-level
  siblings: BlockNode[];    // the array that contains node
  index: number;            // node's position within siblings
}

export function locate(blocks: BlockNode[], uid: BlockUid): Located | null {
  const walk = (siblings: BlockNode[], parent: BlockNode | null): Located | null => {
    for (let i = 0; i < siblings.length; i++) {
      const node = siblings[i];
      if (node.uid === uid) return { node, parent, siblings, index: i };
      const found = walk(node.children, node);
      if (found) return found;
    }
    return null;
  };
  return walk(blocks, null);
}

export function findNode(blocks: BlockNode[], uid: BlockUid): BlockNode | null {
  return locate(blocks, uid)?.node ?? null;
}

/** Depth-first uids in on-screen order; children of collapsed blocks hidden. */
export function visibleUids(blocks: BlockNode[]): BlockUid[] {
  const out: BlockUid[] = [];
  const walk = (nodes: BlockNode[]) => {
    for (const n of nodes) {
      out.push(n.uid);
      if (!n.collapsed) walk(n.children);
    }
  };
  walk(blocks);
  return out;
}

/** The uid path from the outermost ancestor down to `uid` inclusive; empty
 * when the uid is not in this tree. One depth-first pass, so a renderer that
 * needs a per-row "is the focus inside my subtree?" test builds a Set from
 * this once at the root instead of re-walking every row's own subtree. */
export function ancestorChain(blocks: BlockNode[], uid: BlockUid): BlockUid[] {
  const path: BlockUid[] = [];
  const walk = (nodes: BlockNode[]): boolean => {
    for (const node of nodes) {
      path.push(node.uid);
      if (node.uid === uid || walk(node.children)) return true;
      path.pop();
    }
    return false;
  };
  return walk(blocks) ? path : [];
}

/** Whether two trees hold the same blocks in the same order with the same
 * field values. Short-circuits on reference-equal arrays and nodes and at the
 * first difference; every BlockNode field is compared, so this is the verdict
 * a JSON.stringify compare of both trees would reach without serializing
 * either (see outlineState's change signal). */
export function blocksEqual(a: readonly BlockNode[],
                            b: readonly BlockNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!nodeEqual(a[i], b[i])) return false;
  }
  return true;
}

function nodeEqual(a: BlockNode, b: BlockNode): boolean {
  return a === b || (
    a.uid === b.uid
    && a.text === b.text
    && a.heading === b.heading
    && a.view_type === b.view_type
    && a.collapsed === b.collapsed
    && a.order_idx === b.order_idx
    && a.created_at === b.created_at
    && a.updated_at === b.updated_at
    && blocksEqual(a.children, b.children)
  );
}

/** Reduce a uid set to its "roots": the uids with no ancestor also in the
 * set, in the given order. Acting on a root (move, delete) carries its whole
 * subtree along, so a listed descendant needs no op of its own. */
export function selectionRoots(blocks: BlockNode[], uids: BlockUid[]): BlockUid[] {
  const set = new Set(uids);
  return uids.filter((uid) => {
    for (let p = locate(blocks, uid)?.parent; p; p = locate(blocks, p.uid)?.parent) {
      if (set.has(p.uid)) return false;
    }
    return true;
  });
}

export function visibleNeighbor(blocks: BlockNode[], uid: BlockUid,
                                dir: "up" | "down"): BlockUid | null {
  const order = visibleUids(blocks);
  const i = order.indexOf(uid);
  if (i < 0) return null;
  return order[dir === "up" ? i - 1 : i + 1] ?? null;
}

/** Deep-copies a block tree. Exported so a caller that needs to apply many
 * ops in place — stampBaseTextHashes, notably — can clone once up front
 * instead of paying applyOps' per-call clone once per op. */
export function cloneTree(nodes: BlockNode[]): BlockNode[] {
  return nodes.map((n) => ({ ...n, children: cloneTree(n.children) }));
}

function sortSiblings(siblings: BlockNode[]): void {
  siblings.sort((a, b) => a.order_idx - b.order_idx);
}

function siblingsOf(tree: BlockNode[], parentUid: BlockUid | null): BlockNode[] | null {
  if (parentUid === null) return tree;
  return locate(tree, parentUid)?.node.children ?? null;
}

/** Mirror of the server's ShiftSiblings effect: everything at or past
 * fromOrderIdx moves up one — except the block being moved, whose order_idx
 * is about to be overwritten (matching SetParent-after-ShiftSiblings). Not
 * exported: nothing outside this module calls it. */
function shiftFrom(siblings: BlockNode[], fromOrderIdx: OrderIdx,
                   except?: BlockUid): void {
  for (const s of siblings) {
    if (s.uid !== except && s.order_idx >= fromOrderIdx) {
      s.order_idx = orderIdxAfter(s.order_idx);
    }
  }
}

// Type-only probe, kept here (not a test file) because shiftFrom isn't
// exported: a dense sibling position must not satisfy its fromOrderIdx
// parameter. Assignability is checked structurally, so this fails tsc
// (and the @ts-expect-error below would go unused) if fromOrderIdx is ever
// widened to plain `number`.
// @ts-expect-error a dense position is not an OrderIdx
const _shiftFromRejectsDensePosition: (s: BlockNode[], n: number) => void =
  shiftFrom;
void _shiftFromRejectsDensePosition;

export interface AppliedOps {
  blocks: BlockNode[];
  /** Whether the ops altered anything. Exact rather than conservative: an op
   * that resolves to what the tree already held (text set to itself, a
   * collapse to the current state, a move that lands the block back where it
   * was) reports false, so `false` means the returned tree is `blocksEqual`
   * to the input and a caller may discard it and keep its own state. */
  changed: boolean;
}

/** Whether any op in the batch could touch this page's tree — the same test
 * applyOne makes per op (create by page_title, create_page never, the rest by
 * uid presence), asked of the batch as a whole before anything is cloned.
 *
 * Relevance, not outcome: a create for this page counts even when it will
 * apply nothing, so the skip can never disagree with what applyOne would have
 * done. Safe to read against the PRE-apply tree because a batch with no
 * relevant create adds no uids, and the ops that remove them only ever shrink
 * the set this is asking about. */
function opsTouchPage(blocks: BlockNode[], ops: BlockOp[],
                      pageTitle: string): boolean {
  const uids = new Set<BlockUid>();
  for (const op of ops) {
    if (op.op === "create_page") continue;
    if (op.op === "create") {
      if (op.page_title === pageTitle) return true;
      continue;
    }
    uids.add(op.uid);
  }
  return uids.size > 0 && holdsAny(blocks, uids);
}

/** One depth-first pass, stopping at the first uid the batch names. */
function holdsAny(nodes: BlockNode[], uids: ReadonlySet<BlockUid>): boolean {
  for (const n of nodes) {
    if (uids.has(n.uid) || holdsAny(n.children, uids)) return true;
  }
  return false;
}

/** Apply committed ops to a client tree — the single source of truth for op
 * semantics on the client; both optimistic local edits and remote websocket
 * batches go through here. Ops that don't concern this page are skipped:
 * create is filtered by page_title, everything else by uid presence (the
 * websocket broadcasts ops for ALL pages); create_page never touches a
 * block tree and is always skipped.
 *
 * A batch where every op is skipped that way — the common case, since every
 * open outline sees every other page's broadcasts — returns the input tree
 * itself and allocates nothing. Anything else returns a fresh
 * clone, which may still be `blocksEqual` to the input when the ops resolved
 * to what was already there; `changed` is the verdict either way. */
export function applyOpsWithChange(blocks: BlockNode[], ops: BlockOp[],
                                   pageTitle: string): AppliedOps {
  if (!opsTouchPage(blocks, ops, pageTitle)) return { blocks, changed: false };
  const tree = cloneTree(blocks);
  let changed = false;
  for (const op of ops) changed = applyOpInPlace(tree, op, pageTitle) || changed;
  return { blocks: tree, changed };
}

/** applyOpsWithChange for the callers that only want the tree. */
export function applyOps(blocks: BlockNode[], ops: BlockOp[],
                         pageTitle: string): BlockNode[] {
  return applyOpsWithChange(blocks, ops, pageTitle).blocks;
}

/** One sibling array as it stands, node identities plus the order_idx values
 * about to be overwritten in place — enough to tell a move that reshuffled
 * something from one that put the block back exactly where it was. */
type Layout = { node: BlockNode; orderIdx: OrderIdx }[];

function layoutOf(siblings: BlockNode[]): Layout {
  return siblings.map((node) => ({ node, orderIdx: node.order_idx }));
}

function layoutHeld(before: Layout, siblings: BlockNode[]): boolean {
  return before.length === siblings.length
    && before.every(({ node, orderIdx }, i) =>
      node === siblings[i] && orderIdx === siblings[i].order_idx);
}

/** Applies one op to `tree` in place, mutating it; returns whether the tree
 * actually changed. The single source of op semantics: `applyOpsWithChange`
 * calls this per op on a clone it owns, and a caller applying many ops to
 * one tree it cloned itself (stampBaseTextHashes, notably) calls this
 * directly instead of paying a fresh clone per op via applyOps. Either way,
 * the clone is the caller's responsibility — this function never clones. */
export function applyOpInPlace(tree: BlockNode[], op: BlockOp, pageTitle: string): boolean {
  if (op.op === "create") {
    if (op.page_title !== pageTitle) return false;
    if (locate(tree, op.uid)) return false; // replay of a block we already have
    const siblings = siblingsOf(tree, op.parent_uid ?? null);
    if (siblings === null) return false;    // parent unknown here: skip
    shiftFrom(siblings, op.order_idx);
    siblings.push({
      uid: op.uid, text: op.text, heading: op.heading ?? null,
      view_type: op.view_type ?? null, collapsed: false, order_idx: op.order_idx,
      created_at: null, updated_at: null, children: [],
    });
    sortSiblings(siblings);
    return true;
  }
  if (op.op === "create_page") return false; // page creation: no block tree here
  const found = locate(tree, op.uid);
  if (!found) return false; // op for another page: skip
  if (op.op === "update_text") {
    if (found.node.text === op.text) return false;
    found.node.text = op.text;
  } else if (op.op === "set_collapsed") {
    if (found.node.collapsed === op.collapsed) return false;
    found.node.collapsed = op.collapsed;
  } else if (op.op === "set_heading") {
    const heading = op.heading ?? null;
    if (found.node.heading === heading) return false;
    found.node.heading = heading;
  } else if (op.op === "set_view_type") {
    if (found.node.view_type === op.view_type) return false;
    found.node.view_type = op.view_type;
  } else if (op.op === "delete") {
    found.siblings.splice(found.index, 1);
  } else { // move — order_idx counted BEFORE the moved block is removed
    if (op.page_title != null && op.page_title !== pageTitle) {
      // this outline is the SOURCE of a cross-page move: just remove
      found.siblings.splice(found.index, 1);
      return true;
    }
    const target = siblingsOf(tree, op.parent_uid);
    if (target === null) return false;
    // A move only ever rewrites the source and target sibling arrays, so
    // comparing those two is the whole verdict — and both are bounded by
    // sibling count, never by tree size.
    const source = layoutOf(found.siblings);
    const before = found.siblings === target ? source : layoutOf(target);
    shiftFrom(target, op.order_idx, op.uid);
    found.siblings.splice(found.index, 1);
    found.node.order_idx = op.order_idx;
    target.push(found.node);
    sortSiblings(target);
    return !(layoutHeld(source, found.siblings) && layoutHeld(before, target));
  }
  return true;
}

/** Detach uid's subtree. Returns the new tree and the detached node
 * (null = uid not found; tree returned unchanged). Pure: clones. */
export function removeSubtree(blocks: BlockNode[], uid: BlockUid):
    { tree: BlockNode[]; node: BlockNode | null } {
  const tree = cloneTree(blocks);
  const found = locate(tree, uid);
  if (!found) return { tree, node: null };
  found.siblings.splice(found.index, 1);
  return { tree, node: found.node };
}

/** Insert a detached subtree per the move contract (insert before the
 * block currently at orderIdx). Unknown parentUid: returns tree unchanged. */
export function insertSubtree(blocks: BlockNode[], node: BlockNode,
                              parentUid: BlockUid | null,
                              orderIdx: OrderIdx): BlockNode[] {
  const tree = cloneTree(blocks);
  const siblings = siblingsOf(tree, parentUid);
  if (siblings === null) return tree;
  shiftFrom(siblings, orderIdx);
  siblings.push({ ...node, children: cloneTree(node.children), order_idx: orderIdx });
  sortSiblings(siblings);
  return tree;
}
