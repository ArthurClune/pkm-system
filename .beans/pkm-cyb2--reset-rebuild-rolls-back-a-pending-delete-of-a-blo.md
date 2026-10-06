---
# pkm-cyb2
title: Reset rebuild rolls back a pending delete of a block with links
status: completed
type: bug
priority: normal
created_at: 2026-10-06T10:12:45Z
updated_at: 2026-10-06T10:57:39Z
---

Found by the pkm-ib6j adversarial review (2026-10-06), reproduced. The reset rebuild (rebuildSchema in workerHandlers.ts) runs applySnapshot with foreign_keys=OFF, so a replayed `delete` op's block deletes cascade nothing: the deleted block's refs and block_refs rows stay, dangling on src_block_uid. replayPending's FK guard sees the new violation and rolls the delete op back, so after Reset local data a block the user deleted offline reappears locally until the server's echo removes it. With FKs ON (the window path) the cascade removes them and the delete lands.

Repro: snapshot with uid_r1 (text holds a [[B]] link) and uid_r2 (plain); a pending batch deletes both; applySnapshot under PRAGMA foreign_keys=OFF leaves uid_r1, removes uid_r2. The same with FKs ON leaves neither.

Fix: in localOps.ts's delete case, delete the subtree's refs and block_refs rows explicitly before the blocks, so FKs OFF behaves as the cascade does (the rows are recorded via recordBlocks' replay_log_refs, so rewind is unaffected — check).

- [x] Failing test in applyFkHazards.test.ts (FKs OFF snapshot, pending delete of a block with a link and with a ((uid)) ref)
- [x] Fix in localOps.ts delete
- [x] pnpm test:unit, typecheck

## Summary of Changes

localOps.ts's delete removes the subtree's refs and block_refs rows (two set statements) before the blocks, so a replayed delete lands the same with FKs off (the reset rebuild, where nothing cascades) as on the window path. Tests: FKs-off applySnapshot with a pending delete of a block with a [[link]] / ((uid)) ref now removes it and matches the FKs-on rows; a rewind test restores a deleted block's refs and block_refs. targetedFkHit's REFS and BREFS clauses became unreachable (removing them fails nothing at 20k property runs; with the fix reverted the property fails), so they were dropped; PAGE and CHILD remain. sync-recovery.md and a troubleshooting row updated. Perf: +2 statements per R window, accepted by Arthur, baseline re-recorded. proptest/check.sh web 68/68.
