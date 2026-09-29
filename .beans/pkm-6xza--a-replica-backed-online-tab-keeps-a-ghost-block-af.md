---
# pkm-6xza
title: A replica-backed online tab keeps a ghost block after a skipped ack; only the no-replica lane refetches
status: todo
type: bug
priority: normal
created_at: 2026-09-29T13:20:33Z
updated_at: 2026-09-29T13:20:33Z
parent: pkm-a4t2
---

Review F5 (P2, pre-existing; Fable C9). The durable drain reads only `seq`
from the ack; `ackSkipped` is consulted only on the lane and only under the
no-replica latch (pkm-c2gs). Online, views read the server and refresh only
on WS batches or a `resyncSeq` bump; none of the resync events fires for a
durable skipped ack; the server never broadcasts skipped ops and the tab
drops its own echo; journal cleanup and page deletes send only a seq nudge
that reaches `replicaSync.onSeq` and no view. So the replica tombstones the
row while the screen keeps the ghost, and every debounced edit into it lands
another orphan-edit child under today's conflict header until reconnect or
navigation. Reachable with two tabs or devices. The test "does not refetch
(it has a feed to tombstone the ghost)" and `sync-recovery.md` pin the wrong
premise: the feed tombstones the replica row, not the view.

Design: spec § F5 — both paths consult `ackSkipped`; the callback (renamed
`onSkipped`) fires on any non-empty `skipped` regardless of the latch; the
sync event (renamed `ops-skipped`) bumps resync. Cost: one harmless extra
refetch per skipped ack in a replica-backed tab.

## Todo

- [ ] Invert the `opQueue.replica.test.ts` "does not refetch" test; add the durable-path case; `syncState` rename; `SyncProvider` test that `resyncSeq` moves on a skipped ack
- [ ] Both delivery paths consult `ackSkipped`; `onSkipped` fires regardless of `unavailable`; `ops-skipped` event
- [ ] Docs D3 (`sync-recovery.md` § Ops on blocks the server no longer has and its failure row) and D4 (last step of the online-edit diagram in `sync-and-offline.md`); append a correction to pkm-c2gs's summary
- [ ] verify, perf, merge
