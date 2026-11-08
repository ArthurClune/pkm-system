---
# pkm-n788
title: One write_txn helper owns lock, 503, rollback and commit for every journal-advancing route
status: completed
type: task
priority: low
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-08T14:55:50Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding server F4 (DESIGN). Verdict: HOLDS.

## Why
The write-transaction protocol (BEGIN IMMEDIATE before the first read, map
"locked" to 503 + Retry-After, roll back on any exception, commit, nudge) is
pasted into `post_ops`, `delete_page`, `rename_page`, `cleanup_journal`,
`delete_asset`; `add_sidebar_entry` and `apply_title_migration` take the lock
without the 503 mapping ("uncaught: 500" in backend.md § The write lock).
docs/troubleshooting.md has four separate lock-taken-after-the-read rows.
Only prose enforces "a route whose decision rests on what
it reads takes the lock first"; only the hand-kept list in
`test_journal_advancing_contract.py` enforces the nudge.

## Work
- [x] A `write_txn` context manager (sync; it serves async routes too, see Summary): BEGIN IMMEDIATE, 503 on locked, rollback on raise, commit on clean exit (optionally the nudge)
- [x] Move every `begin_immediate` caller onto it
- [x] A test that `begin_immediate` is called only from the helper
- [x] backend.md § The write lock names the helper; add the sentence that a lock holder must never await the loop before its commit

A helper, not a new state machine: no property suite needed.

## Summary of Changes

- `pkm.server.db.write_txn(db)`: BEGIN IMMEDIATE on entry, a busy lock is
  503 + Retry-After, rollback on any raise, commit on a clean exit (a
  `return` included). One sync context manager serves the async
  `post_ops` too. No async variant was built: its enter and exit need no
  await, and an `async with` body is where an await under the lock would
  go. The nudge stays after the `with` in each route, because their
  nudges differ (ops echo before the seq frame, cleanup only when it
  deleted, migration forced with a generation, asset after the unlink);
  `test_journal_advancing_contract.py` still pins each.
- All seven `begin_immediate` callers moved onto it, each keeping the lock
  before its first deciding read. `add_sidebar_entry` and
  `apply_title_migration` now answer a held lock with 503, not 500.
- `tests/test_write_txn.py`: an AST scan of `server/src` fails on
  `begin_immediate` outside `write_txn`, on a `BEGIN IMMEDIATE`/`EXCLUSIVE`
  string executed outside `pkm.database`, and on an await, commit or
  rollback inside a `with write_txn` body; teeth cases for each.
- backend.md § The write lock names the helper, drops the busy-lock column
  (every route is now 503) and states that a lock holder never awaits the
  loop before its commit; § Post-commit nudges updated; one
  troubleshooting row.
