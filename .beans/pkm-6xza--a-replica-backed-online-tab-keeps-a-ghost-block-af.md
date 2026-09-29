---
# pkm-6xza
title: A replica-backed online tab keeps a ghost block after a skipped ack; only the no-replica lane refetches
status: completed
type: bug
priority: normal
created_at: 2026-09-29T13:20:33Z
updated_at: 2026-09-29T15:34:38Z
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

- [x] Invert the `opQueue.replica.test.ts` "does not refetch" test; add the durable-path case; `syncState` rename; `SyncProvider` test that `resyncSeq` moves on a skipped ack
- [x] Both delivery paths consult `ackSkipped`; `onSkipped` fires regardless of `unavailable`; `ops-skipped` event
- [x] Docs D3 (`sync-recovery.md` § Ops on blocks the server no longer has and its failure row) and D4 (last step of the online-edit diagram in `sync-and-offline.md`); append a correction to pkm-c2gs's summary
- [ ] verify, perf, merge

## Summary of Changes

`web/src/sync/opQueue.ts`: the durable batch loop in `runDrain` now reads the
ack's `skipped` list (via the existing `ackSkipped` reader) right after a
successful `postOps`, before `deleteBatch`, mirroring `deliverLaneHead`.
`deliverLaneHead` dropped its `unavailable !== null &&` guard so it fires on
any non-empty `skipped`, not only while the queue has latched no-replica.
`createReplicaQueue`'s and `createOpQueue`'s last constructor argument is
renamed `onSkippedNoReplica` -> `onSkipped` (their comments updated to match);
`ackSkipped`/`ackSeq` themselves are untouched, left as the hand-rolled
readers pkm-jk1d (Typed ack) will replace with one reader over the generated
`OpsAck` type.

`web/src/sync/syncState.ts` and `SyncProvider.tsx`: pure rename, no behaviour
change. The `SyncEvent` member `"ops-skipped-no-replica"` -> `"ops-skipped"`;
`SyncProvider`'s ref `skippedNoReplicaRef` -> `skippedRef`. `pnpm typecheck`
confirms no stale reference survives (the `transitionSync` exhaustiveness
check on `never` would fail to compile against a stale union member).

Tests: `opQueue.replica.test.ts` inverts the old "a skipped op delivered by
the lane while the replica is otherwise fine does not refetch" test to assert
it now does refetch, and adds three durable-path cases (a skipped ack
refetches; no skipped ops does not; a terminally-rejected batch never calls
`onSkipped`, pinning that the new check sits only in the ack-success branch).
`syncState.test.ts` is a pure rename of the `ops-skipped-no-replica` describe
block and its two `it()`s. `SyncProvider.test.tsx` gets a composed test:
render `SyncProvider`, let the first connect settle, enqueue an op whose
fake `/api/ops` ack names a skipped op, and assert `resyncSeq` strictly
increased from the post-connect baseline (isolating the fix's bump from the
first-connect's own leftover-batch-flush bump) — verified red against the
pre-fix `opQueue.ts`/`syncState.ts`/`SyncProvider.tsx` (temporarily checked
out from the pre-Task-1 commit, then restored) and green after.

Docs: `sync-recovery.md` § "Ops on blocks the server no longer has" — the
failure-modes table's no-replica-only row and the section's closing
paragraph now state that both delivery paths consult `ackSkipped`
regardless of `unavailable`, and that a replica-backed tab's feed tombstones
the row while the ack refetch is what tells the view. `sync-and-offline.md`
§ "An online edit, end to end" — the diagram's last step and the paragraph
below it now say views refetch when catch-up moved data or an ack skipped an
op, not only for a no-replica tab. `docs/troubleshooting.md` § Sync and
offline gained one row (ghost block after a skipped ack, sync-recovery.md
link, pkm-6xza). `.beans/pkm-c2gs--*.md` got a dated correction: its
`unavailable !== null` guard, described there as narrowing to a genuinely
no-replica session, also silently skipped every durable delivery.

Deviations from the plan: none — the plan's line numbers, test bodies, and
code locations matched the code as found.

Not done here (per the brief, orchestrator's job after merge): running the
full Playwright suite and `perf/check.sh`.
