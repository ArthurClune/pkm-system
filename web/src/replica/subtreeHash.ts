// pattern: Functional Core
// Canonical hash of a subtree's (uid, text) pairs (spec section 1),
// order-independent. Its server twin is `subtree_hash` in
// pkm.contracts.ops; shared/fixtures/subtree_hash.json pins both.

import { sha256Hex, type Sha256Hex } from "./sha256";

export function subtreeHash(
  pairs: Iterable<readonly [string, string]>,
): Sha256Hex {
  // Plain code-unit comparison, never localeCompare: uids are ASCII
  // (UID_RE), so this agrees with Python's default sort.
  const sorted = [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canon = sorted
    .map(([uid, text]) => `${uid} ${sha256Hex(text)}`)
    .join("\n");
  return sha256Hex(canon);
}
