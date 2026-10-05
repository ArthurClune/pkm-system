---
# pkm-iaa0
title: Replica unit tests print SQLite errors to stderr
status: todo
type: task
created_at: 2026-10-05T12:01:45Z
updated_at: 2026-10-05T12:01:45Z
---

pnpm test:unit output carries stderr lines from replica tests that exercise failure paths on purpose: 'replica: a changes window will not apply, re-snapshotting past it ReplicaError: SQLITE_CONSTRAINT_NOTNULL ...', 'applyChanges: window failed its deferred FK check, rebootstrapping SQLite3Error ...', 'replica: ROLLBACK after a failed transaction SQLite3Error: cannot rollback - no transaction is active' (e.g. src/replica/workerHandlers.test.ts 'a failed open leaves the carry for the open after close'). Test output should be pristine: capture or assert those logs in the tests that provoke them (vi.spyOn(console, ...)), so a new stray error stands out.
