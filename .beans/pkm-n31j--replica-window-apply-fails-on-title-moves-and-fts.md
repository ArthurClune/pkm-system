---
# pkm-n31j
title: Replica window apply fails on title moves and FTS corruption stalls sync instead of rebuilding
status: in-progress
type: bug
priority: normal
created_at: 2026-09-03T08:13:28Z
updated_at: 2026-09-03T08:22:58Z
---

## Symptom

iPad PWA, 2026-09-02 ~22:02-22:10 (server-log local time), after renaming "SIS" onto the existing "Student Record System" page (a merge) and tabbing in/out of the PWA:

1. `Local sync is stuck: SQLITE_CORRUPT_VTAB: sqlite3 result code 267: database disk image is malformed` — Reset local data
2. `Local sync is stuck: SQLITE_CONSTRAINT_UNIQUE: sqlite3 result code 2067: UNIQUE constraint failed: pages.title`

Server log: the same `changes?since=` window re-pulled with growing backoff for minutes (`since=54671` 22:02:44-22:03:47, `since=54681` 22:05:26-22:07:45, `since=54548` 22:08:55-22:09:01), each cleared only by a manual reset (snapshot fetch at 22:03:51, 22:05:50, 22:07:49, 22:09:02).

## Root causes

**Error 2 (deterministic, reproduced in a unit test):** `applyWindow` upserts pages before it applies tombstones, and `pages.title` is `UNIQUE`. The merge deleted page 3521 "SIS"; a stale client then re-created "SIS" as page 4518 by replaying old `#[[SIS]]` text. One window therefore carried a tombstone for 3521 AND page 4518 titled "SIS"; the upsert of 4518 collided with the still-present 3521. A title swap within one window fails the same way. The window rolls back, the cursor never advances, so every retry refetches the same window forever. `sidebar_entries.title` has the same hazard.

**Error 1 (mechanism confirmed, origin not):** the replica's `blocks_fts`/`pages_fts` are FTS5 external-content tables. In SQLite 3.53 `fts5StorageDeleteFromIndex` raises `SQLITE_CORRUPT_VTAB` when its running row/token totals would go negative — i.e. the FTS index believed it held fewer rows than the content table. Every trigger-driven delete/update then throws. None of our SQL shapes (savepoint rollback in reapplyPending/enqueueBatch, full rollback, cascade deletes, rowid reuse, upsert DO UPDATE, snapshot re-apply) reproduces the divergence against the real engine; the origin is on-device (state persisted non-atomically or a second writer). What IS ours: the client treats a corrupt cache as a stall needing a manual reset, and the automatic `rebase` recovery would run `DELETE FROM blocks` over the corrupt index and fail again. A schema-rebuilding reset always clears it (it drops the FTS tables).

## Plan

- [x] Failing tests: window with page tombstone + re-created title; title swap; sidebar equivalents
- [x] `applyWindow`: apply tombstones before upserts; park colliding titles so swaps apply
- [x] Failing test: corruption-shaped replica error during pull triggers a schema-rebuilding reset, not a stall banner
- [x] `isCorruptionError` predicate (errors.ts) + replicaSync routes it to `recover("reset")`, once per session, with console diagnostics
- [x] Rebase recovery that hits corruption escalates to reset
- [x] docs/architecture/sync-and-offline.md: window order, title parking, symptom rows
- [ ] Full web verify (typecheck, unit coverage, e2e)
