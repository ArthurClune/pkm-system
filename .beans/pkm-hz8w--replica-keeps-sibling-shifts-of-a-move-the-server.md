---
# pkm-hz8w
title: Replica keeps sibling shifts of a move the server skipped
status: completed
type: bug
priority: normal
created_at: 2026-10-03T12:03:48Z
updated_at: 2026-10-03T17:47:14Z
parent: pkm-nws9
---

Found by the sync protocol property (pkm-yxcs). A client moves a block another device already deleted. Its optimistic apply shifts the destination siblings' order_idx; the server skips the move and shifts nothing; the feed tombstones only the moved block, so the replica keeps the shifted keys forever (A: 21/31/41/51 vs server 20/30/40/50). Later creates/moves at keys between the two sets then place differently. Shrunk: Edit(B,[delete pt_seed_2]), Edit(A,[move pt_seed_2 under top at 0; delete pt_seed_1]), Edit(A,[delete pt_seed_1]) (seed -496395878, path 36:0:2:1:4:5:4:4:6:6:6:6:6:10:10:10:10:10:10:10:10:10:10:10:10:10, replayPath AAAACABAGA/G:V1). Ruling (Arthur 2026-10-03): when the server skips a create or move, it touches the destination sibling group in the journal so the next pull re-ships the true order_idx. Fix on feat/pkm-yxcs-sync-harness with the shrunk case as a unit test.

- [x] Shrunk case as a failing server unit test (tests/test_skip_reships_siblings.py)
- [x] Journal-touch the destination sibling group on a skipped create/move, where the server can name it (live parent; top level of a page_title that names a page)
- [x] A top-level move with no page_title of a gone block: the block's delete row in `changes` records its page (`page_id`), and the skip re-ships that page's top level
- [x] A diverted create's tombstone records the page the client placed the block on (page_title's page, else the parent's tombstone page), so a later untitled top-level skip of that uid re-ships it (F4)
- [x] Docs: sync-recovery.md / backend.md missing targets, troubleshooting row


## Summary of Changes
When the server skips a move of a block it no longer has, it journals the destination sibling group (no column changes) so the next window re-ships their true order_idx. For an untitled top-level move, the page comes from the block's tombstone: a new nullable `changes.page_id` written by the delete trigger (migration, idempotent, checked on a prod copy), and a diverted create now leaves a page-bearing tombstone for the client's uid. Newest-first scan, no index (an index regressed perf). Commits b1e2fcd6, c5d97ba0, f9d86b20. Remaining applied-op variants: pkm-dbr1.
