---
# pkm-pp7q
title: Pull loses the children of a block moved out from under a deleted parent
status: completed
type: bug
priority: normal
created_at: 2026-10-03T15:11:14Z
updated_at: 2026-10-03T17:47:14Z
parent: pkm-nws9
---

Found by the sync protocol property (pkm-yxcs). Device A moves pt_seed_5 (with child pt_A_1) out from under pt_seed_4 and deletes pt_seed_4 in one batch. Device B, which held pt_seed_4 > pt_seed_5 > pt_A_1, pulls a window carrying pt_seed_4's tombstone and pt_seed_5's new top-level row, but not pt_A_1 (unchanged on the server). The replica applies tombstones first and the delete cascades the whole local subtree; pt_seed_5's row restores it, but pt_A_1 is never re-shipped: B silently loses it. Seed -1720339345, path 2846:7:5:5:6:7:7:6:20:25:19:19:19:19:19:19:19:19:19:26:28:0:4:33:23:30:31:30:30:30:30:31:31:34:32:34:33:31:31:32:31:31:31:31:31:31:37:31:37:41:37, replayPath GABA//t:1B (3/3). Controller ruling: apply a window's upserts before its tombstones (every block the server actually deleted has its own journalled tombstone, so the replica's cascade must never reach a block the server kept); stop and report if tombstones-first is required for a reason that makes reordering unsafe (e.g. page title uniqueness, cross-page moves off a deleted page).

- [x] Root cause and why tombstones are applied first today
- [x] Failing unit test (real sqlite): moved-out child's subtree survives the parent's tombstone in one window; cross-page variant (block moved off a deleted page)
- [x] Reorder apply (and the snapshot path if affected)
- [x] Property: F8 replay passes; earlier replays still pass
- [x] Docs: sync-recovery.md / sync-and-offline.md apply order; troubleshooting row
- [x] Window boundary: a block tombstone ships only with its delete row; the harness can cap windows
- [x] Deeper variant documented and pinned (strict xfail); filed as pkm-d3qh

## Resolution

Tombstones-first came from pkm-n31j (UNIQUE page/sidebar titles); pkm-8uc9 later relied on it for a reused page id shipped as tombstone plus live row. Neither reason applies to blocks: uids are never reused, so no block is both tombstoned and shipped live.

Two rules keep a block tombstone's local cascade off a block the server kept, when that block's move out ships no later than the tombstone:

1. Same window: applyWindow applies page and sidebar tombstones first, then pages and blocks, then block tombstones, then sidebar, then the drop and the replay.
2. Across windows: the feed ships a block tombstone only in the window that holds its delete row (sync_core.tombstone_entities). Before, any window holding an older live row of a block absent now shipped its tombstone, ahead of the window with the move out (review finding, fix round 1). The server journals a delete row for every block it deletes (the delete trigger fires for cascaded rows, with or without recursive_triggers, verified; JournalBlock marks a uid with no block row deleted).

A kept block left the deleted subtree by a move at a lower seq than the delete, in the delete row's window or earlier, and the upserts take it out of the cascade first. The kept block may be a descendant that moved along with its moved-out ancestor; its own row never changes, so nothing would re-ship it.

Not covered (pkm-d3qh, open; review finding, fix round 2): the moved-out ancestor is itself deleted in a later window. Its move row hydrates to nothing (absent now, delete row later), so the cascade runs over the replica's stale subtree and the kept block's unchanged children are lost. D > A > K > L; move A top, delete D, move K top, delete A; windows of 1-2 rows lose L. Pinned as a strict xfail in server/tests/test_sync_block_tombstone_window.py; the sync property's windowLimit arbitrary yields only "no limit" until it is fixed (plumbing kept so seeds and paths replay unchanged).

Page tombstones may stay first because leaving a page rewrites page_id on every block of the moved subtree, so each kept block ships its own row. The snapshot path applies no tombstones. Covered by apply.test.ts, server/tests/test_sync_block_tombstone_window.py, test_sync_core.py, and two fixed property scenarios (same window; window limit 1). The property carries a per-example changes window limit, currently always none (see above).


## Summary of Changes
A window's block upserts apply before its block tombstones (page/sidebar tombstones stay first), and the server ships a block tombstone only in the window that holds its delete row. Real-sqlite unit tests, server limit-1 tests and props fixed scenarios. The deeper multi-window variant is documented and pinned by a strict xfail (pkm-d3qh). Commits c1b5184f, 80765389, 5eb2ed3b.
