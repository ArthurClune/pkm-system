---
# pkm-h1c6
title: 'Replica file-level corruption: reset cannot heal it and ROLLBACK masks the error'
status: completed
type: bug
priority: normal
created_at: 2026-09-28T18:53:41Z
updated_at: 2026-09-28T19:02:29Z
---

iPad PWA 2026-09-28 19:29: quick_check reported b-tree damage (freelist size mismatch, pages never used), FTS integrity ok. Two defects keep the session wedged:

1. rebuildSchema (workerHandlers.ts) is a logical DROP/CREATE inside the same file; with a damaged freelist it throws SQLITE_CORRUPT, so the one automatic reset (and 'Local repair') can never succeed. Needs a file-level recreate (close, unlink the pool file, reopen) that preserves pending batches.
2. wrapSqlite.transaction (db.ts) runs ROLLBACK after SQLite already auto-rolled back on CORRUPT/IOERR/FULL; 'cannot rollback - no transaction is active' replaces the original error, so isCorruptionError misses it and the pull counts window strikes -> rebase instead of reset.

Also observed: the create of NeaikGSJ-r3sl3PY never reached the server while its later move did -> HTTP 400 (trace pending).

## Todo
- [x] transaction(): preserve original error when SQLite already rolled back (plus rollbackToSavepoint in queue.ts/apply.ts)
- [x] file-level recreate path for corruption recovery, keeping pending batches
- [x] explain lost create -> move-before-create 400 (lane/durable overtake; follow-up bean)
- [x] troubleshooting row + sync-and-offline doc update
- [x] tests, typecheck, perf check

## Summary of Changes

- `db.ts`: `transaction()` no longer lets a failed `ROLLBACK` (after SQLite's own auto-rollback on CORRUPT/IOERR/FULL) replace the original error. New `rollbackToSavepoint` does the same for `ROLLBACK TO`; used by `enqueueBatch`'s optimistic-apply savepoint and `reapplyPending`.
- `workerHandlers.ts`: `rebuildOrReplaceFile` — a reset whose in-place rebuild throws a corruption error calls the new `discardDbFile` dep and rebuilds into a fresh file. Used by `commitRecovery` (reset) and `reset()`.
- `worker.ts`: `discardDbFile` closes the DB and unlinks the file and its `-journal` from the SAH pool.
- `errors.ts`: `isCorruptionMessage` shared by the worker and `isCorruptionError`.
- Docs: sync-and-offline § Rebootstrap triggers (corrected the schema-change row: reset drops tables, it does not rebuild the file; added the file-replacement and error-masking notes); troubleshooting row.
- Lost-create/overtake ordering split out to pkm-5ekv (design decision).
- Verified: pnpm test:unit, pnpm typecheck, pnpm verify (exit 0), perf/check.sh frontend: no changes against the baseline.
