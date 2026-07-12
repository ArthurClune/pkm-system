---
# pkm-o9o5
title: 'Sync protocol: DB generation token for rebuilt-database detection'
status: todo
type: feature
created_at: 2026-07-12T18:45:48Z
updated_at: 2026-07-12T18:45:48Z
parent: pkm-y8p0
blocking:
    - pkm-gtov
---

Final review of pkm-dnl6 found the reset flag one-sided: it fires only when the client cursor is AHEAD of the journal (routes_sync.py). An importer-rebuilt DB repopulates the journal, so latest_seq usually exceeds a stale client cursor and reset never fires — a replica would silently pull from mid-journal and permanently miss rows. Fix at the protocol level before (or with) the web replica bean: add a random generation/epoch token in a small meta table, echo it in ChangesPayload/SnapshotPayload, client re-bootstraps on mismatch. Additive change (CREATE TABLE IF NOT EXISTS), no columns on existing tables.
