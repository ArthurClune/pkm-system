---
# pkm-i35e
title: Poison-repair ownership is claimed on rejection but released only on repair success
status: completed
type: bug
priority: normal
created_at: 2026-09-29T13:20:39Z
updated_at: 2026-09-29T15:43:50Z
parent: pkm-a4t2
---

Review F8 (P2, pre-existing, narrow; Fable C1 as verified).
`rejectDurableBatch` pauses and emits `poisonPending` before marking;
`replicaSync` sets `authoritativeRepair = "poison"`. The one release,
`completeAuthoritativeRepair`, runs inside the repair that `onPoison`
triggers, and `onPoison` fires only for matched intents.

Path A (confirmed, hard to reach): `markPoisoned` matches no row (the row
vanished between POST and mark, realistically a manual "Reset local data"
with discard overlapping an in-flight drain POST the server rejects).
`markRetainedPoison` clears the intents, emits nothing and returns
`blocked("recovering")`: no problem event, queue paused with no resumer,
`pullLoop`, the deferred rebase and `resetLocalData` all early-return until
reload while edits pile up in pending.

Path B (partly): `discardProblem` resumes without releasing. The designed
re-POST normally re-enters `rejectDurableBatch`, matches, repairs and
releases; the claim sticks for the session only if the re-POST no longer
draws a terminal status (F4's territory) or the replica stays broken.

Design: spec § F8 — `markRetainedPoison` reports a round with intents and no
match; `replicaSync` releases the claim and resumes; `discardProblem` releases
before it resumes.

## Todo

- [x] Failing tests: an unmatched marking round releases the claim, resumes delivery and lets a later bootstrap recovery run; `discardProblem` releases and the re-POST path still repairs
- [x] Report the unmatched round from `markRetainedPoison`; release and resume in `replicaSync`; release in `discardProblem`
- [x] Docs: `sync-recovery.md` § A batch the server rejects — ownership lifecycle table (claimed on rejection; released on repair success, unmatched round, or discard); troubleshooting row
- [x] verify (perf and merge run by the orchestrator after this branch lands)

## Summary of Changes

Closed the two exits (spec § F8) that could leave `replicaSync`'s
`authoritativeRepair = "poison"` claim held forever with no resumer:

- **Unmatched marking round** (Path A): `opQueue.ts`'s `markRetainedPoison`
  gains `onPoisonMarkUnmatched(fn: () => void): () => void`, firing once per
  round where retained intents existed and none matched a durable row.
  `replicaSync.ts` subscribes alongside its existing `onPoisonPending`
  subscription and releases the claim + resumes the queue when it fires (a
  no-op when no claim is held).
- **`discardProblem`** (Path B): `SyncProvider.tsx`'s `actions.discardProblem`
  now calls `replicaSync.completeAuthoritativeRepair("poison")` unconditionally
  before its startup/mid-session branches, so both release correctly (a
  harmless no-op when no claim is held, via `completeAuthoritativeRepair`'s own
  reason guard).

Each new test asserts the release directly (not just eventual delivery) and
was confirmed red against the unfixed code before the fix landed, including
the composed test across the real `opQueue` + `replicaSync` + `SyncProvider`
stack.

Files touched: `web/src/sync/opQueue.ts`, `web/src/sync/opQueue.replica.test.ts`,
`web/src/sync/replicaSync.ts`, `web/src/sync/replicaSync.test.ts`,
`web/src/sync/SyncProvider.tsx`, `web/src/sync/SyncProvider.test.tsx`,
`docs/architecture/sync-recovery.md`, `docs/troubleshooting.md`.
