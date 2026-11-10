---
# pkm-t57n
title: Five journal-advancing routes commit outside write_txn (500 under contention)
status: completed
type: bug
priority: high
created_at: 2026-11-09T21:39:23Z
updated_at: 2026-11-10T07:03:19Z
parent: pkm-4gda
---

Plan: docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md § W2. Child of the 2026-11-09 maintainability review epic.

## Summary

create_page, the today auto-create in get_page and get_journal, delete_sidebar_entry and reorder_sidebar_entries now run under write_txn (503 with Retry-After under contention); commit_and_nudge_threadpool is deleted; a scan test keeps route commits out of pkm/server.
