// pattern: Functional Core
// Stamp ops at construction time on the main thread with the hash of what
// they replace: update_text with the hash of the text it replaces (and the
// title of the page its block lives on), delete with the subtree hash of the
// block and every descendant it removes.
//
// The worker fills base_text_hash and base_subtree_hash in from the replica
// (replica/queue.ts) only when they are undefined, so any op that never
// reaches the database goes to the server unguarded — which is EVERY op in a
// session whose replica could not be opened, because those ride the
// in-memory fallback lane and post head.ops verbatim. The server then returns
// early into plain last-write-wins (ops_core.py, "check 3: legacy"), so a
// concurrent edit from the tab that DOES own the replica is overwritten
// outright instead of being landed on the daily note as a conflict header.
// (An edit to a block the server no longer has lands on the daily note
// whether or not it carries a hash.) "Two tabs open is normal" is the
// argument for the online-only fallback, and this was that decision's cost.
// A hashless delete likewise removes the subtree outright; a hashed one whose
// subtree changed elsewhere keeps the server's texts on the daily note.
//
// page_title is stamped independently of the hash: it never gates
// whether the op applies, it only labels the daily-note header the server
// writes when an edit targets a block that no longer exists there. The
// worker (replica/queue.ts) fills it from the replica only alongside a hash it
// fills itself. A filled durable row can differ from the fallback-lane copy of
// the same batch_id after a lost reply; the server's replay hash ignores
// these fields, so that difference replays rather than 409s.
//
// Every hash is taken against the tree the batch was planned from, walking
// the batch in order, mirroring what the worker does inside its transaction:
// capture BEFORE this op's own optimistic apply. That is what lets a user's
// own edit chain flush cleanly — op N leaves the text op N+1's hash matches —
// and what makes a delete after earlier ops in its batch (a child's delete,
// a child's edit) hash only what those ops left.
//
// Ownership is unchanged: the worker still defers to a supplied hash or
// page_title, so this is additive.
import type { BlockNode } from "../api/payloads";
import type { BlockOp, DeleteOp, UpdateTextOp } from "../api/ops";
import { sha256Hex } from "../replica/sha256";
import { subtreeHash } from "../replica/subtreeHash";
import { applyOps, findNode } from "./tree";

// A type predicate, not a boolean: `create_page` carries no `uid`, so without
// the narrowing the loop below cannot read `op.uid` at all.
const needsStamp = (op: BlockOp): op is UpdateTextOp | DeleteOp =>
  (op.op === "update_text" &&
   (op.base_text_hash === undefined || op.page_title === undefined))
  || (op.op === "delete" && op.base_subtree_hash === undefined);

/** The (uid, text) pair of `node` and of every descendant, the input
 * subtreeHash takes. */
export function nodeSubtreePairs(node: BlockNode): [string, string][] {
  const pairs: [string, string][] = [];
  const walk = (n: BlockNode): void => {
    pairs.push([n.uid, n.text]);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return pairs;
}

function stampOne(op: UpdateTextOp | DeleteOp, node: BlockNode,
                  pageTitle: string): BlockOp {
  if (op.op === "delete") {
    return { ...op, base_subtree_hash: subtreeHash(nodeSubtreePairs(node)) };
  }
  return {
    ...op,
    ...(op.base_text_hash === undefined
      ? { base_text_hash: sha256Hex(node.text) } : {}),
    ...(op.page_title === undefined ? { page_title: pageTitle } : {}),
  };
}

export function stampBaseTextHashes(
  blocks: BlockNode[], pageTitle: string, ops: readonly BlockOp[],
): BlockOp[] {
  // applyOps clones the whole tree, so only re-apply while a later op still
  // needs stamping. A large paste batch on a big page would otherwise pay for
  // a clone per op for no benefit.
  const lastNeedingStamp = ops.reduce(
    (last, op, index) => (needsStamp(op) ? index : last), -1);
  if (lastNeedingStamp === -1) return [...ops];
  let tree = blocks;
  const stamped: BlockOp[] = [];
  for (const [index, op] of ops.entries()) {
    let wireOp: BlockOp = op;
    if (needsStamp(op)) {
      const node = findNode(tree, op.uid);
      // No node: this tree does not know the block (a cross-page op, or one
      // the batch itself creates). No hash means plain LWW, or for a delete
      // an unguarded removal — exactly what the worker does when the replica
      // lacks the row; no page_title means the daily-note header falls back
      // to "(page unknown)" if an update_text ever lands there.
      if (node !== null) wireOp = stampOne(op, node, pageTitle);
    }
    stamped.push(wireOp);
    if (index < lastNeedingStamp) tree = applyOps(tree, [wireOp], pageTitle);
  }
  return stamped;
}

/** The op without its stamps. Undo history records ops unstamped, so a replay
 * hashes the tree it replays against rather than a hash captured at record
 * time. */
export function withoutStamps(op: UpdateTextOp): UpdateTextOp {
  const { base_text_hash: _hash, page_title: _title, ...rest } = op;
  return rest;
}
