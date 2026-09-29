---
# pkm-8uc9
title: A reused page id ships through the feed with no tombstone, so stale replica refs point at the new page
status: todo
type: bug
priority: normal
created_at: 2026-09-29T13:20:37Z
updated_at: 2026-09-29T13:20:37Z
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

- [ ] Failing tests: `dedupe_window` flag; `routes_sync` pull spanning delete and reuse returns the tombstone and the new page; replica `applyWindow` with a tombstone and a live page for one id leaves the old blocks and other blocks' refs to that id gone and the new page present
- [ ] Select `deleted`; flag on `Window`; tombstone rule in `routes_sync`
- [ ] Note here whether a block uid recreated by undo has the same shape (out of scope unless trivial)
- [ ] Docs: `sync-and-offline.md` feed section tombstone rule; `backend.md` changes-route row if it describes tombstones; troubleshooting row
- [ ] verify, perf, merge
