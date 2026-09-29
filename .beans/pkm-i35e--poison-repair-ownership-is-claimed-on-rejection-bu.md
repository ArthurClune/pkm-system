---
# pkm-i35e
title: Poison-repair ownership is claimed on rejection but released only on repair success
status: todo
type: bug
priority: normal
created_at: 2026-09-29T13:20:39Z
updated_at: 2026-09-29T13:20:39Z
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

- [ ] Failing tests: an unmatched marking round releases the claim, resumes delivery and lets a later bootstrap recovery run; `discardProblem` releases and the re-POST path still repairs
- [ ] Report the unmatched round from `markRetainedPoison`; release and resume in `replicaSync`; release in `discardProblem`
- [ ] Docs: `sync-recovery.md` § A batch the server rejects — ownership lifecycle table (claimed on rejection; released on repair success, unmatched round, or discard); troubleshooting row
- [ ] verify, perf, merge
