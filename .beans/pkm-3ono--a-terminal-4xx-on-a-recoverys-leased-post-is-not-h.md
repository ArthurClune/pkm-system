---
# pkm-3ono
title: A terminal 4xx on a recovery's leased POST is not handled as a rejection
status: completed
type: bug
priority: normal
created_at: 2026-11-11T19:16:33Z
updated_at: 2026-11-12T17:25:27Z
parent: pkm-4gda
---

A terminal 4xx on a POST made through OpQueue.deliverLeased is not handled as a rejection.

## Mechanism
deliverLeased posts the leased batch, and deliverLaneAhead posts the lane entries ahead of it, through postOps. Neither catches an error that isTerminalRejection recognises: they throw. No poison mark is made for the row (rejectDurableBatch is a drain-only path), a rejected lane entry is not discarded (deliverLaneHead's lane pause, settleLaneHead and desync emit are skipped), and no onDesync fires. The queue harness records this (queueHarness.ts: deliverLeased throws, no poison mark, and a lane entry stays).

- A preemptible recovery fails with reportReplicaFailure true and holdsPoison() false, so the pull shows its recovery-failed banner.
- A blocking reset (resetLocalData) raises ResetBlockedError, which asks the user to discard the pending queue over one rejected row.

## Convergence
Once the recovery run ends and releases its claim, the drain re-posts the same row and gets the proper handling (poison mark for a durable row, lane discard plus outline repair for a lane entry). The pull's backoff retries the recovery. So the state converges, only after a misleading banner, and a reset can push the user to throw away the whole queue.

## Symptom
A recovery-failed banner, or a reset refused with a request to discard pending edits, when the real cause is one batch the server rejects.

## Docs
sync-recovery.md § A batch the server rejects says isTerminalRejection decides at both delivery sites in opQueue.ts; deliverLeased is a third POST site that rule does not cover.

Found by the pkm-rx21 investigation. Not fixed there.

## Plan

docs/superpowers/plans/2026-11-12-leased-rejection.md

- [x] Leased durable rejection poisons the row
- [x] Leased lane-ahead rejection discards the entry and goes on
- [x] Blocking reset over a rejected row defers to the poison repair
- [x] Queue property models a leased rejection as a rejection
- [x] Docs, gates

## Summary of Changes

Symptom: after a batch the server rejected outright, a recovery showed the
**recovery-failed** banner, or **Reset local data** stopped with
`ResetBlockedError` ("unsent changes not delivered") and asked the user to
discard every pending edit.

Cause: a recovery posts its leased batch, and the lane entries ahead of it,
through `OpQueue.deliverLeased` and `deliverLaneAhead`. Neither handled
`isTerminalRejection`, though the drain's two delivery sites did.

Fix:
- `deliverLeased`: on a terminal rejection of the batch, it claims `poison`,
  keeps the mark intent, fails the ticket, starts the mark without awaiting
  it, and throws, so the row never reaches `heldAcks`. It can't await the
  mark because the run's own lease holds the worker gate the mark passes.
- `deliverLaneAhead`: on a terminal rejection, it discards the entry as the
  drain does, and delivery goes on.
- `replicaSync.flushLease` "blocking": when a poison claim has landed, it
  refuses with "rejected-batch repair in progress" instead of
  `ResetBlockedError`.
- Queue property: it models a leased rejection as a rejection. It gains a
  recovery-heavy command mix and two teeth mutants, and its floors are
  re-derived only where the mix moved them.

Rule: docs/architecture/sync-recovery.md § A batch the server rejects, plus
§ The recovery barrier and § runRecovery.

Follow-ups: pkm-9hki (markRetainedPoison clears every intent), pkm-j5wi
(driverTeeth flaky under a full web run), pkm-mgc0 (full web proptest run
stalls).
