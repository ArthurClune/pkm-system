---
# pkm-bggw
title: 'Sync/replica: comment and doc corrections from the state-machine review'
status: todo
type: task
priority: low
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-07T18:42:45Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Small items, no behaviour change.

- [ ] `SyncProvider.tsx`: the comment above `statusRef`/`modeRef` says both are written synchronously; `modeRef` is written during render and lags `onState` by one render (sync F9)
- [ ] Delete the worker's unused `reset` RPC (`workerHandlers.ts`; no production caller), or route the discard path through it (replica F5)
- [ ] A batch-lifecycle state table (pending / poisoned / frozen / settled: which tables hold what, who moves it) in `replayLog.ts`'s header or sync-and-offline.md; `pendingGuard.ts`'s AUTOINCREMENT comment says ids are unique within one file only and that every rebuild clears `ackedSeqs` (replica F8)
- [ ] `applyChanges`/`applySnapshot` comments state that pruning `ackedSeqs` relies on bootstrap and pull never running at once, which `replicaSync` guarantees (replica F9)
