// pattern: Functional Core
// Stamp update_text ops with the hash of the text they replace, at op
// construction time on the main thread.
//
// The worker fills base_text_hash in from the replica (replica/queue.ts) only
// when it is undefined, so any op that never reaches the database goes to the
// server unguarded — which is EVERY op in a session whose replica could not be
// opened, because those ride the in-memory fallback lane and post head.ops
// verbatim. The server then returns early into plain last-write-wins
// (ops_core.py, "check 3: legacy"), so a concurrent edit from the tab that DOES
// own the replica is overwritten outright instead of being preserved as a
// [[conflict]] sibling; and the edit-vs-delete path, also gated on the hash,
// raises "block not found" -> 400, which makes the lane discard the entry
// (pkm-4ubd). "Two tabs open is normal" is the load-bearing argument for
// pkm-bjae's online-only fallback, and this was that decision's cost.
//
// The hash is taken against the tree the batch was planned from, walking the
// batch in order, mirroring what the worker does inside its transaction:
// capture BEFORE this op's own optimistic apply. That is what lets a user's own
// edit chain flush cleanly — op N leaves the text op N+1's hash matches.
//
// Ownership is unchanged: the worker still defers to a supplied hash, so this
// is additive.
import type { BlockNode } from "../api/payloads";
import type { BlockOp, UpdateTextOp } from "../api/ops";
import { sha256Hex } from "../replica/sha256";
import { applyOps, findNode } from "./tree";

// A type predicate, not a boolean: `create_page` carries no `uid`, so without
// the narrowing the loop below cannot read `op.uid` at all.
const needsHash = (op: BlockOp): op is UpdateTextOp =>
  op.op === "update_text" && op.base_text_hash === undefined;

export function stampBaseTextHashes(
  blocks: BlockNode[], pageTitle: string, ops: readonly BlockOp[],
): BlockOp[] {
  // applyOps clones the whole tree, so only re-apply while a later op still
  // needs a hash. A large paste batch on a big page would otherwise pay for a
  // clone per op for no benefit.
  const lastNeedingHash = ops.reduce(
    (last, op, index) => (needsHash(op) ? index : last), -1);
  if (lastNeedingHash === -1) return [...ops];
  let tree = blocks;
  const stamped: BlockOp[] = [];
  for (const [index, op] of ops.entries()) {
    let wireOp: BlockOp = op;
    if (needsHash(op)) {
      const node = findNode(tree, op.uid);
      // No node: this tree does not know the block (a cross-page op, or one
      // the batch itself creates). No hash means plain LWW — exactly what the
      // worker does when currentText returns null.
      if (node !== null) {
        wireOp = { ...op, base_text_hash: sha256Hex(node.text) };
      }
    }
    stamped.push(wireOp);
    if (index < lastNeedingHash) tree = applyOps(tree, [wireOp], pageTitle);
  }
  return stamped;
}
