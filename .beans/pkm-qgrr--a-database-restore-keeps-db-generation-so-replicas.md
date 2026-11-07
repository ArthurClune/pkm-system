---
# pkm-qgrr
title: A database restore keeps db_generation, so replicas that pulled past the backup diverge silently
status: todo
type: bug
priority: high
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-07T18:42:45Z
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
- [ ] Red test: restoring through the new path changes `/api/sync/changes`' `generation`
- [ ] One restore helper (`pkm` subcommand or `python -m`) that copies the snapshot and rotates `db_generation`; `icloud_backup.py restore` uses it
- [ ] README § Restore uses the helper (and says why)
- [ ] Row in docs/troubleshooting.md
