---
# pkm-8uc9
title: A reused page id ships through the feed with no tombstone, so stale replica refs point at the new page
status: completed
type: bug
priority: normal
created_at: 2026-09-29T13:20:37Z
updated_at: 2026-09-29T15:39:08Z
parent: pkm-a4t2
---

Review F7 (P2, pre-existing; Astra C6). `pages.id` is `INTEGER PRIMARY KEY`
without `AUTOINCREMENT`, so deleting the highest page and creating another
reuses the id. The delete trigger does journal `('page', id, 1)`, but
`dedupe_window` collapses both rows into one entry with no ordering and
`routes_sync` derives tombstones from absence in current state, so the id now
names a live page, no tombstone is emitted, and the replacement ships as an
upsert. On the server the `refs` cascade removed other blocks' refs to the
deleted page (`refs` has no journal trigger); in the replica those refs
survive and resolve to the new page, since `upsertBlock` clears only the
touched block's own refs and the page cascade runs only on a page tombstone.

Design: spec § F7 — the window query selects `deleted`; `dedupe_window`
returns each entity with a `tombstoned` flag; `routes_sync` emits a tombstone
when the entity is absent from current state or flagged, and still ships the
live payload. The replica needs nothing new: tombstones lead the window, so
the page delete cascades the old blocks and refs before the upserts. Applies
to the id-keyed kinds `page` and `sidebar`; blocks keep the presence rule.
Not chosen: `AUTOINCREMENT` (a rebuild of an FK-referenced live table; DDL is
the only migration mechanism) or a stable page uid.

## Todo

- [x] Failing tests: `dedupe_window` flag; `routes_sync` pull spanning delete and reuse returns the tombstone and the new page; replica `applyWindow` with a tombstone and a live page for one id leaves the old blocks and other blocks' refs to that id gone and the new page present
- [x] Select `deleted`; flag on `Window`; tombstone rule in `routes_sync`
- [x] Note here whether a block uid recreated by undo has the same shape (out of scope unless trivial): a block uid recreated by undo is the same block: everything a server block delete cascades (its subtree, its refs and block_refs) is journalled per row or re-derived by `upsertBlock`, so the presence rule loses nothing; no change
- [x] Docs: `sync-and-offline.md` feed section tombstone rule; `backend.md` changes-route row if it describes tombstones (it does not; left alone); troubleshooting row
- [x] verify (branch-local: server suite, web checks, the new e2e spec)
- [x] perf (before merge), merge

## Summary of Changes

- `sync_core`: `dedupe_window` takes `(seq, kind, entity_id, deleted)` rows
  and records every entity with a delete row in `Window.tombstoned`; the pure
  `tombstone_entities` tombstones an entity absent from current state, or a
  `page`/`sidebar` id (`REUSABLE_ID_KINDS`) with a delete row even when a live
  row holds it; `tombstoned_ids` lists them by kind. Blocks keep the presence
  rule.
- `routes_sync.sync_changes`: selects `deleted`, builds tombstones through
  `tombstone_entities`, and still ships the live row, so a reused id arrives as
  tombstone plus live row.
- Dependents closure: a window holding a page delete row also hydrates every
  current block on that page or with a ref to it (`_reused_page_dependents`),
  deduped against the window's own uids and through the normal hydration path
  (parents and dependency pages ship too). No extra query without a page
  delete in the window. This does not decide final convergence (later
  windows re-ship those blocks anyway); it makes the page whole again by the
  window's COMMIT, closing the gap between windows of one pull loop.
- `web/src/replica/apply.ts`: `applyWindow`'s ordering comment states the
  reused-id rule instead of promising "never both"; characterisation tests in
  `apply.test.ts` pin the replica side (no code change needed).
- E2E `web/e2e/reused-page-id.spec.ts`: red on the unfixed server (stale
  backlink on the new page, read offline), green with the fix.
- Docs: `sync-and-offline.md` § The changes feed tombstone rule;
  troubleshooting row.
