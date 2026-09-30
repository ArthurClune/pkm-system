---
# pkm-xwb5
title: 'Web sync extraction pass: ordered-outbox core, typed ack reader, listeners for constructor callbacks, pure placementFor, classifiers out of replicaSync'
status: in-progress
type: task
priority: low
created_at: 2026-09-29T13:20:52Z
updated_at: 2026-09-30T14:25:38Z
parent: pkm-a4t2
---

Review § Maintainability. The server side got cleaner in the window (one
classifier, one text-edit predicate, one replay hash, all pure); the web side
absorbed each fix as a branch inside an existing closure and is one extraction
pass behind. `opQueue.ts` holds seven concerns in one closure (poison-intent
localStorage, listeners, ack parsing, lane ordering, lane delivery, the
durable 4xx protocol, `runDrain`, enqueue retention), as the 2026-08-17 review
already said; `replicaSync.ts` inlines `isStallShaped`, `isWindowFailure`,
`isFreshCorruption`; `workerHandlers.applyOne` inlines the placement rules the
server keeps in its pure planner, which is why placement has no shared
fixture.

Scope: an ordered-outbox core and a typed ack reader out of `opQueue.ts`;
the three constructor callbacks become listeners and the late-bound refs in
`SyncProvider.tsx` go; a pure `placementFor` with placement cases added to
`missing_targets.json`; the classifiers out of `replicaSync.ts`. The six
distinctions the confirmed findings turn on are the target vocabulary: a
draft's base identity; failed delivery versus rejected intent; acknowledged
versus still-optimistic; a replica with optimistic edits is not a clean copy;
leased rows are not durable rows; replica convergence versus view refresh.

Architectural: brainstorm and spec when picked up. Do it before the next sync
feature rather than during one, and after the fixes in this epic land.
