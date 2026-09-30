---
# pkm-xwb5
title: 'Web sync extraction pass: ordered-outbox core, typed ack reader, listeners for constructor callbacks, pure placementFor, classifiers out of replicaSync'
status: completed
type: task
priority: low
created_at: 2026-09-29T13:20:52Z
updated_at: 2026-09-30T16:19:33Z
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


## Summary of Changes

Spec docs/superpowers/specs/2026-09-30-web-sync-extraction-design.md, plan docs/superpowers/plans/2026-09-30-web-sync-extraction.md. Behaviour-preserving refactor in six tasks plus a final-review fix wave:

- Vocabulary: `unusable` is the one name for a failed open (ReplicaUnusableError, RPC field `unusable`, worker latch, problem kind `replica-unusable`, ReplicaUnusableBanner); opQueue's umbrella variable is `availability`. UI copy unchanged.
- Ordered-outbox core: sync/outbox.ts (pure lane ordering: entries, appended, follows; append/markFollows/laneHead/headPrecedes/settleHead/forget/clearMarks), sync/poisonIntents.ts (pure) + sync/poisonIntentStore.ts (localStorage, same key and format), sync/listeners.ts (shared helper, Imperative Shell), one noteCommitted(ack) for the three delivery sites.
- Classifiers: sync/syncFailures.ts (PullStarvedError, isStallShaped, isWindowFailure, isFreshCorruption(error, alreadyRebuilt)).
- placementFor: replica/placement.ts decides create/move placement for localOps.applyOne; existingLocalPageId shares getOrCreateLocalPage's canonicalisation; five new placement_cases rows, two of which fail if the keep branch or the title lookup regresses.
- Listeners: createOpQueue(replica) takes no callbacks; OpQueue.onDesync/onDrain/onSkipped and ReplicaSync.onSkipped are listeners; drainObserverRef, skippedRef and repairLegacyRef are gone. Tests pin that no event can precede a same-tick subscription and that StrictMode doesn't double a refetch.
- Docs: frontend.md module map, sync-and-offline.md, sync-recovery.md, troubleshooting.md.
- initialEntryBytes rebaselined 387737 -> 406680 (branch builds 388053, +528 over main from the new eager module boundaries).

Accepted deviations from "no behaviour change":
- After SyncProvider really unmounts, a late desync (including one after queue.dispose()) no longer starts repairActiveOutlineSessions.
- isStallShaped duck-types ApiError/OfflineError (a Core file can't value-import the API client); equivalent today because ApiError is the only Error subclass with `status` and OfflineError the only status-0 construction.

Verification: pnpm verify exit 0 (3027 unit after the fix wave, 72/72 Playwright), server pytest 2229 passed, perf/check.sh frontend no changes. Whole-branch review on Fable: ready to merge; its one Important code finding (a fixture row for existingLocalPageId) fixed.
