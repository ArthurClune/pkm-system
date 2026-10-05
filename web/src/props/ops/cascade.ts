// pattern: Functional Core
// The ops property's one replay exclusion beyond minted rows: a block a
// head-window tombstone cascaded away while a pending move had placed it
// under the deleted block. The server skipped that move and kept the block;
// the skip echo re-ships it on the next pull, which check S confirms. Checks
// 3 and R drop exactly those blocks, with their subtrees, from both sides.
import type { NormalGraph } from "../sync/normalise";

/** A pending move: the block and the parent it was sent under. */
export interface PendingMove { uid: string; parent: string | null }

/** The uids to set aside: each moved block whose target parent the window
 * tombstoned, absent from `replayed` but present in `other` (the fresh
 * replica or the server), plus its subtree as `other` holds it. */
export function cascadeExclusions(moves: readonly PendingMove[],
                                  tombstoned: ReadonlySet<string>,
                                  replayed: NormalGraph,
                                  other: NormalGraph): Set<string> {
  const inReplayed = new Set(replayed.blocks.map((b) => b.uid));
  const inOther = new Set(other.blocks.map((b) => b.uid));
  const children = new Map<string, string[]>();
  for (const b of other.blocks) {
    if (b.parent_uid !== null) {
      children.set(b.parent_uid, [...(children.get(b.parent_uid) ?? []), b.uid]);
    }
  }
  const out = new Set<string>();
  const take = (uid: string): void => {
    if (out.has(uid)) return;
    out.add(uid);
    for (const c of children.get(uid) ?? []) take(c);
  };
  for (const m of moves) {
    if (m.parent !== null && tombstoned.has(m.parent) && !inReplayed.has(m.uid) &&
        inOther.has(m.uid)) take(m.uid);
  }
  return out;
}

/** `g` without the blocks in `uids`. */
export function withoutBlocks(g: NormalGraph, uids: ReadonlySet<string>): NormalGraph {
  return uids.size === 0 ? g : { ...g, blocks: g.blocks.filter((b) => !uids.has(b.uid)) };
}
