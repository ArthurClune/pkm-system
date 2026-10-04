---
# pkm-xtqz
title: 'Rename races a batch: link not rewritten'
status: completed
type: bug
priority: normal
created_at: 2026-10-04T16:59:29Z
updated_at: 2026-10-04T19:16:26Z
parent: pkm-nws9
---

Found by the widened sync property (pkm-dbr1 branch). rename_page_rows snapshots the blocks referencing the page with a SELECT before its write transaction starts (Python's implicit BEGIN comes at the first UPDATE). A batch committing in between is ordered before the rename, but its [[Old]] link is not rewritten while its ref points at the renamed page; a serial replay of the same order does rewrite it. Fixed scenario: 'rename racing a batch that links the renamed page' in web/src/props/sync/sync.prop.ts. Fix on feat/pkm-dbr1-cross-page.

- [x] Server unit test pinning the race
- [x] Snapshot inside the write transaction (rename and merge paths)
- [x] Fixed scenario passes
- [x] Docs/troubleshooting row

## Summary of Changes

rename_page takes BEGIN IMMEDIATE before its first read (503 + Retry-After when the write lock is busy; rollback on every exit), so the referencing-block read and the rewrite see one state. Server unit test pins the race; the fixed scenario passes. Docs: backend.md § The write path and API table; troubleshooting row.
