---
# pkm-2zvr
title: Complete local-API ancestor reads
status: completed
type: task
priority: normal
created_at: 2026-08-03T13:27:22Z
updated_at: 2026-08-03T13:31:42Z
---

Align local API ancestor reads with server parity using real sqlite RED/GREEN TDD, preserving fetchAncestors(db, uids), start_uid, depth, and root-first ordering.

## Summary of Changes

- Added real-sqlite ancestor traversal tests for 100, 101, 102, and 150-depth chains plus a five-node cycle.
- Replaced the local ancestor CTE depth cap with the server-equivalent visited-path cycle guard.
- Verified parity and FCIS/type checks.
