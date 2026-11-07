---
# pkm-5mp0
title: Importer swaps pkm.sqlite3 beside a live -wal; the next open sees the old database
status: todo
type: bug
priority: normal
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-07T18:42:45Z
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
- [ ] Red test: a `-wal` beside the target makes the import refuse with a "stop the server first" message
- [ ] Refuse when `pkm.sqlite3-wal` or `-shm` exists beside the target
- [ ] README import section: stop the server first
