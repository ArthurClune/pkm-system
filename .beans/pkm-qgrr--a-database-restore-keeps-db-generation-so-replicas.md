---
# pkm-qgrr
title: A database restore keeps db_generation, so replicas that pulled past the backup diverge silently
status: completed
type: bug
priority: high
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-07T21:20:13Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Verdict: HOLDS.

## Symptom
After restoring a snapshot (deploy/README.md § Restore is a plain `cp`;
`deploy/icloud_backup.py restore` likewise), a device whose cursor was past
the backup's head and that next pulls after the new timeline's head has
passed its cursor applies only rows after its cursor. It never receives the
new timeline's rows in between and keeps lost-timeline rows the server no
longer has. Edits to those ghost blocks become conflict notes. No rebootstrap
ever fires. The iPad PWA (closed for a day while the Mac writes) is exactly
that device.

## Cause
`db_generation` is minted once (`schema.py`, INSERT OR IGNORE) and rotated
only by `title_migration.apply_title_migration` via
`sync_meta.rotate_database_generation`. `routes_sync.sync_changes`'s only
cursor guard is `since > latest`. `changes.seq` restarts from the restored
`sqlite_sequence`, so seqs are reused. Replica side:
`replica/apply.ts` `applyChanges` rebootstraps only on `reset` or a
generation change.

## Fix
- [x] Red test: restoring through the new path changes `/api/sync/changes`' `generation`
- [x] One restore helper (`pkm` subcommand or `python -m`) that copies the snapshot and rotates `db_generation`; `icloud_backup.py restore` uses it
- [x] README § Restore uses the helper (and says why)
- [x] Row in docs/troubleshooting.md

## Summary of Changes

- New `python -m pkm.backup.restore --data-dir DATA SNAPSHOT`
  (`server/src/pkm/backup/restore.py`, Shell): copies the snapshot as bytes
  to `pkm.sqlite3.restore-tmp`, runs `init_db` and
  `rotate_database_generation` on the copy, then `os.replace`s it over the
  db named by `config.json`. It refuses with exit 2 when the snapshot is
  missing, when the snapshot has its own `-wal`/`-shm`, and when
  `-wal`/`-shm` sit beside the target. The target check runs just before the
  swap and shares `pkm.db_sidecars` (Core) with the importer (pkm-5mp0).
- The snapshot is copied rather than opened because a read-only connection
  to a WAL-mode file leaves `-wal`/`-shm` beside it on close. That was
  confirmed empirically, and it would litter `backups/sqlite/` and iCloud.
- `deploy/icloud_backup.py restore` now puts `db/pkm-T.sqlite3` into `--out`
  through that module, run on the checkout's `server/.venv/bin/python`
  (`--pkm-python` overrides). It exits 1 when that python is missing or the
  step fails.
- deploy/README.md § Restore uses the helper and says why (seq reuse; a
  `rebase` keeps queued edits). It also covers the sidecar refusal and its
  remedy, and the iCloud restore paragraph is updated.
- Docs: import-export-and-backup.md § Restore (new), backend.md `sync_meta`
  writers and module tree, sync-recovery.md trigger row, and a
  troubleshooting.md row.
- Tests: `test_backup_restore.py` (red first: generation unchanged after a
  copy-only restore) and three new restore tests in `test_icloud_backup.py`.
