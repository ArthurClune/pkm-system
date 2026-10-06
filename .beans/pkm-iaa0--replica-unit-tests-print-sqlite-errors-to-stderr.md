---
# pkm-iaa0
title: Replica unit tests print SQLite errors to stderr
status: completed
type: task
priority: normal
created_at: 2026-10-05T12:01:45Z
updated_at: 2026-10-06T06:18:47Z
---

pnpm test:unit output carries stderr lines from replica tests that exercise failure paths on purpose: 'replica: a changes window will not apply, re-snapshotting past it ReplicaError: SQLITE_CONSTRAINT_NOTNULL ...', 'applyChanges: window failed its deferred FK check, rebootstrapping SQLite3Error ...', 'replica: ROLLBACK after a failed transaction SQLite3Error: cannot rollback - no transaction is active' (e.g. src/replica/workerHandlers.test.ts 'a failed open leaves the carry for the open after close'). Test output should be pristine: capture or assert those logs in the tests that provoke them (vi.spyOn(console, ...)), so a new stray error stands out.

## Summary of Changes

Replica tests that provoke failure paths on purpose now spy on console.warn and assert the log they cause; web test:unit output is empty of stray lines. The engine's sqlite3_step() lines go through sqlite3.config.warn, bound to console.warn at init, so testDb.ts rebinds it to look console up per call. testDb.ts also hides the global localStorage during engine init to silence Node's ExperimentalWarning. Generated-batch tests (replay, rewind) assert every logged line is an engine primary-key conflict. UndoRedoKeys.test.tsx passes the shared router future flags.
