---
# pkm-jvid
title: Asset strip-delete and journal cleanup read before writing without the write lock
status: completed
type: bug
priority: normal
created_at: 2026-10-22T21:04:56Z
updated_at: 2026-10-23T08:26:27Z
---

Found by the final review of the architecture-docs cut (pkm-pddd), from reading the code; not reproduced yet.

Two journal-advancing routes read and then write without `begin_immediate()`, so a concurrent commit can land between the read and the write it justifies:

- `routes_assets.delete_asset`, strip mode (the `/files` delete): it reads `SELECT text FROM blocks` for each referencing block in autocommit, then `UPDATE blocks SET text = <stripped>`. An ops batch that edits the block in between is overwritten with no conflict note. Only `_delete_if_unreferenced` takes the lock.
- `routes_pages.cleanup_journal`: it checks `is_page_empty` and `_daily_is_linked` with autocommit reads, then calls `delete_page_rows`. A block created on that day in between is deleted with the page.

`Db` uses sqlite3's default isolation, so the implicit BEGIN comes only at the first DML.

## Checklist
- [x] Reproduce each race in a test (interleave a commit between the read and the write)
- [x] Take `begin_immediate()` before the first read in both routes, answering 503 `Retry-After` on busy as rename and delete do
- [x] backend.md § The write lock: move both routes into the table as locked

## Summary of Changes

- `delete_asset` takes `BEGIN IMMEDIATE` before its first read, for both modes (the strip and `if_unreferenced`), and rolls back on any error; busy answers 503 + `Retry-After`.
- `cleanup_journal` does the same before the emptiness and link checks.
- Tests reproduce each race (a second connection commits between read and write) and the 503 on a held lock.
- backend.md § The write lock lists both routes as locked; two troubleshooting rows added.
