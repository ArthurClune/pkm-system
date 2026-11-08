---
# pkm-bggw
title: 'Sync/replica: comment and doc corrections from the state-machine review'
status: completed
type: task
priority: low
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-08T15:54:13Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Small items, no behaviour change.

- [x] `SyncProvider.tsx`: the comment above `statusRef`/`modeRef` says both are written synchronously; `modeRef` is written during render and lags `onState` by one render (sync F9)
- [x] Delete the worker's unused `reset` RPC (`workerHandlers.ts`; no production caller), or route the discard path through it (replica F5)
- [x] A batch-lifecycle state table (pending / poisoned / frozen / settled: which tables hold what, who moves it) in `replayLog.ts`'s header or sync-and-offline.md; `pendingGuard.ts`'s AUTOINCREMENT comment says ids are unique within one file only and that every rebuild clears `ackedSeqs` (replica F8)
- [x] `applyChanges`/`applySnapshot` comments state that pruning `ackedSeqs` relies on bootstrap and pull never running at once, which `replicaSync` guarantees (replica F9)

## Summary of Changes

Each item re-checked against the code after Groups E and F; none had
already been fixed, so all four were done.

- `SyncProvider.tsx`: the comment now says only `statusRef` is written
  synchronously (in onStatus); `modeRef` is written during render and lags
  an `onState` report by one render.
- The worker's `reset` RPC is deleted (handler, `Replica.reset`,
  `ReplicaRpc`, the client facade, `absentReplica`, `memReplica` and the
  test fakes). Its one test of a damaged-file reset was a duplicate of the
  `commitRecovery` reset test; the acked-seq rebuild test now resets through
  `prepareRecovery`/`commitRecovery`. `rebuildOrReplaceFile` now requires
  its snapshot.
- `replayLog.ts` header: a batch-lifecycle table (pending / poisoned /
  frozen / settled: the `pending_ops` row, the `replay_log` records, what
  moves the batch), plus that a snapshot clears the log so a batch it drops
  or a rebase settles goes straight to settled. `pendingGuard.ts`: ids are
  unique within one file only, and every rebuild or replacement clears
  `ackedSeqs`.
- `workerHandlers.ts` `applySnapshot`/`applyChanges` comments: pruning
  `ackedSeqs` relies on no pull running beside a bootstrap, which
  `replicaSync` ensures (pulls only once started, bootstraps only before).
