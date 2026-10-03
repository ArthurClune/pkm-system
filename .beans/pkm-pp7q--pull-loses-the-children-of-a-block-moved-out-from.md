---
# pkm-pp7q
title: Pull loses the children of a block moved out from under a deleted parent
status: in-progress
type: bug
created_at: 2026-10-03T15:11:14Z
updated_at: 2026-10-03T16:40:00Z
parent: pkm-nws9
---

Found by the sync protocol property (pkm-yxcs). Device A moves pt_seed_5 (with child pt_A_1) out from under pt_seed_4 and deletes pt_seed_4 in one batch. Device B, which held pt_seed_4 > pt_seed_5 > pt_A_1, pulls a window carrying pt_seed_4's tombstone and pt_seed_5's new top-level row, but not pt_A_1 (unchanged on the server). The replica applies tombstones first and the delete cascades the whole local subtree; pt_seed_5's row restores it, but pt_A_1 is never re-shipped: B silently loses it. Seed -1720339345, path 2846:7:5:5:6:7:7:6:20:25:19:19:19:19:19:19:19:19:19:26:28:0:4:33:23:30:31:30:30:30:30:31:31:34:32:34:33:31:31:32:31:31:31:31:31:31:37:31:37:41:37, replayPath GABA//t:1B (3/3). Controller ruling: apply a window's upserts before its tombstones (every block the server actually deleted has its own journalled tombstone, so the replica's cascade must never reach a block the server kept); stop and report if tombstones-first is required for a reason that makes reordering unsafe (e.g. page title uniqueness, cross-page moves off a deleted page).

- [x] Root cause and why tombstones are applied first today
- [x] Failing unit test (real sqlite): moved-out child's subtree survives the parent's tombstone in one window; cross-page variant (block moved off a deleted page)
- [x] Reorder apply (and the snapshot path if affected)
- [x] Property: F8 replay passes; earlier replays still pass
- [x] Docs: sync-recovery.md / sync-and-offline.md apply order; troubleshooting row

## Resolution

Tombstones-first came from pkm-n31j (UNIQUE page/sidebar titles); pkm-8uc9 later relied on it for a reused page id shipped as tombstone plus live row. Neither reason applies to blocks: uids are never reused (presence rule), so no block is both tombstoned and shipped live, and the server journals every block it deletes (cascaded rows too, with or without recursive_triggers, verified). applyWindow now applies page and sidebar tombstones first, then pages and blocks, then block tombstones, then sidebar, then the drop and the replay. Page tombstones may stay first because leaving a page rewrites page_id on every block of the moved subtree, so each kept block ships its own row. The snapshot path wipes and reloads and applies no tombstones, so it is not exposed. A fixed property scenario ("moved-out child survives its old parent's deletion on another device") fails before the fix and passes after.
