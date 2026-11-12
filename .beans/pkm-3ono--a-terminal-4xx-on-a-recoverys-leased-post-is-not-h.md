---
# pkm-3ono
title: A terminal 4xx on a recovery's leased POST is not handled as a rejection
status: in-progress
type: bug
priority: normal
created_at: 2026-11-11T19:16:33Z
updated_at: 2026-11-12T14:36:31Z
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

- [ ] Leased durable rejection poisons the row
- [ ] Leased lane-ahead rejection discards the entry and goes on
- [ ] Blocking reset over a rejected row defers to the poison repair
- [ ] Queue property models a leased rejection as a rejection
- [ ] Docs, gates
