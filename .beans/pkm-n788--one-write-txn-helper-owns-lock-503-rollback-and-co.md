---
# pkm-n788
title: One write_txn helper owns lock, 503, rollback and commit for every journal-advancing route
status: todo
type: task
priority: low
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-07T18:42:45Z
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
- [ ] Sync and async `write_txn` context managers: BEGIN IMMEDIATE, 503 on locked, rollback on raise, commit on clean exit (optionally the nudge)
- [ ] Move every `begin_immediate` caller onto it
- [ ] A test that `begin_immediate` is called only from the helper
- [ ] backend.md § The write lock names the helper; add the sentence that a lock holder must never await the loop before its commit

A helper, not a new state machine: no property suite needed.
