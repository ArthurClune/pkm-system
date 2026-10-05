// pattern: Functional Core
// The ops property's one replay exclusion beyond minted rows: a block a
// head-window tombstone cascaded away while a pending move had placed it
// under a block the tombstone removed (the tombstoned block itself, or any
// block under it, a pending create included), when the server skipped that
// move and kept the block. The skip echo re-ships it on the next pull, which
// check S confirms. Checks 3 and R drop exactly those blocks, with the part
// of their subtrees the cascade took, from both sides.
import type { NormalGraph } from "../sync/normalise";

/** A pending move: the block, the parent it was sent under, and its index
 * in its batch (what the ack's `skipped` names). */
export interface PendingMove { uid: string; parent: string | null; index: number }

/** A row a window ships, as far as the cascade's tree needs it. */
export interface ShippedRow { uid: string; parent_uid: string | null }

const childMap = (rows: Iterable<ShippedRow>): Map<string, string[]> => {
  const children = new Map<string, string[]>();
  for (const b of rows) {
    if (b.parent_uid !== null) {
      children.set(b.parent_uid, [...(children.get(b.parent_uid) ?? []), b.uid]);
    }
  }
  return children;
};

const subtree = (roots: Iterable<string>, children: ReadonlyMap<string, string[]>,
                 within?: ReadonlySet<string>): Set<string> => {
  const out = new Set<string>();
  const take = (uid: string): void => {
    if (out.has(uid) || (within !== undefined && !within.has(uid))) return;
    out.add(uid);
    for (const c of children.get(uid) ?? []) take(c);
  };
  for (const uid of roots) take(uid);
  return out;
};

/** Every block a window's block tombstones remove: each tombstoned uid and
 * its descendants in the tree the replica cascades over, which is `before`
 * (the replica before the window) with the window's `shipped` rows laid over
 * it, since the tombstones apply after the window's upserts. */
export function cascadeRemoved(tombstoned: ReadonlySet<string>, before: NormalGraph,
                               shipped: readonly ShippedRow[]): Set<string> {
  const rows = new Map<string, ShippedRow>(before.blocks.map((b) => [b.uid, b]));
  for (const b of shipped) rows.set(b.uid, b);
  return subtree(tombstoned, childMap(rows.values()));
}

/** The uids to set aside: each moved block that the cascade removed, sent
 * under a parent the cascade removed by a move the ack lists as skipped
 * (`skipped`: op indices), absent from `replayed` but present in `other`
 * (the fresh replica or the server); with the part of its subtree in
 * `other` that the cascade also removed. */
export function cascadeExclusions(moves: readonly PendingMove[],
                                  skipped: ReadonlySet<number>,
                                  removed: ReadonlySet<string>,
                                  replayed: NormalGraph,
                                  other: NormalGraph): Set<string> {
  const inReplayed = new Set(replayed.blocks.map((b) => b.uid));
  const inOther = new Set(other.blocks.map((b) => b.uid));
  const roots = moves.filter((m) =>
    m.parent !== null && removed.has(m.parent) && removed.has(m.uid) &&
    skipped.has(m.index) && !inReplayed.has(m.uid) && inOther.has(m.uid))
    .map((m) => m.uid);
  return subtree(roots, childMap(other.blocks), removed);
}

/** `g` without the blocks in `uids`. */
export function withoutBlocks(g: NormalGraph, uids: ReadonlySet<string>): NormalGraph {
  return uids.size === 0 ? g : { ...g, blocks: g.blocks.filter((b) => !uids.has(b.uid)) };
}
