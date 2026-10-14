---
# pkm-pipt
title: 'Replica: a bootstrap snapshot answered before an acked commit drops that commit''s text'
status: todo
type: bug
priority: low
created_at: 2026-10-14T13:53:33Z
updated_at: 2026-10-14T13:53:33Z
---

Found in the pkm-26y7 review. `replica.applySnapshot` (replicaSync.ts ~394) wipes the replica tables and replays only rows still pending. A batch acked while the snapshot fetch is out is then missing from the replica until the `pull()` that follows straight after; an edit enqueued in that gap is hashed against the wrong text (spurious conflict). Needs an empty replica that already holds pending rows, so narrow. Not yet established whether the drain actually runs during bootstrap.

Likely fix: the same held-ack check pkm-26y7 added to the window guard, against `snap.seq`.

## Todo

- [ ] Establish whether the queue drains during a bootstrap snapshot fetch
- [ ] If so, vitest regression beside web/src/replica, then the held-ack check against snap.seq
