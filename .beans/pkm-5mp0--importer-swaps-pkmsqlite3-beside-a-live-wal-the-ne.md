---
# pkm-5mp0
title: Importer swaps pkm.sqlite3 beside a live -wal; the next open sees the old database
status: completed
type: bug
priority: normal
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-07T21:20:13Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding serverlib F3. Verdict: HOLDS-NARROWER.

## Symptom
Running the importer with `--out` at a data dir whose server is running (or
that holds a crash-left `pkm.sqlite3-wal`) replaces the main file but leaves
the old WAL. SQLite replays it over the new file on the next open: a fresh
connection saw the old tables, not the import (repro script in the review).
With a partial WAL the result is a mix of both databases.

## Cause
`importer/run.py` `main`: `os.replace(tmp, out / "pkm.sqlite3")` with no
check for `-wal`/`-shm` or a live server. The README import section says
re-running is safe and never says to stop the server.

## Fix
- [x] Red test: a `-wal` beside the target makes the import refuse with a "stop the server first" message
- [x] Refuse when `pkm.sqlite3-wal` or `-shm` exists beside the target
- [x] README import section: stop the server first

## Summary of Changes

- `importer/run.py` refuses with exit 2 and "stop the server first" when
  `pkm.sqlite3-wal` or `-shm` sits beside `--out/pkm.sqlite3`. It checks
  before any work and again just before the `os.replace`, cleaning up both
  temps. The message comes from the new `pkm.db_sidecars` (Core), shared
  with `pkm.backup.restore` (pkm-qgrr).
- Found while verifying: an idle running server holds no connection and
  leaves no sidecars, so this check catches a crash-left WAL or a server
  mid-write, not a running server. The README and docs say so, and stopping
  the server stays the operator's step. Apple's `/usr/bin/sqlite3` keeps
  WAL files on close (persistent WAL), so the refusal's remedy is to start
  and stop the server once, which was verified on a scratch server.
- The README import section says to stop the server first.
  import-export-and-backup.md and troubleshooting.md are updated.
- Tests: `test_a_live_sidecar_beside_the_target_refuses_the_import` (wal,
  shm; red first: the import exited 0) and
  `test_a_server_started_during_the_import_refuses_the_swap`.

Follow-up (review): both importer checks now go through
`db_swap.swap_refusal`, which folds leftover sidecars when `pkm.sqlite3`
exists and refuses only while another connection keeps them. The tests are
reworked around real connections:
- `test_the_import_folds_the_sidecars_a_closed_reader_left`
- `test_the_import_refuses_while_a_connection_holds_the_target`
- `test_an_unreadable_target_does_not_block_the_import` (SQLite drops a junk
  WAL beside a non-database on close)
- `test_a_server_started_during_the_import_refuses_the_swap`
