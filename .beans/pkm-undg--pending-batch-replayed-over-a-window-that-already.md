---
# pkm-undg
title: Pending batch replayed over a window that already holds it
status: completed
type: bug
priority: normal
created_at: 2026-10-03T14:19:22Z
updated_at: 2026-10-03T17:47:14Z
parent: pkm-nws9
---

Found by the sync protocol property (pkm-yxcs). reapplyPending replays every pending batch as if unapplied; when the server has committed it but the client hasn't processed the ack, the window already contains the batch and the replay double-applies it. Per-op keepSlot/placementFor 'already placed' checks fail whenever a later op (same batch, later batch, or another device) moved the target. Permanent: that window was the batch's only echo. Shapes: two moves of one uid (+2 siblings), cross-uid moves (+2), move then create (order swap), superseded update_text (old text returns). Live in production without a reload: lost ack + the batch's own WS nudge pulls before the 250 ms redelivery. Seed 388766564, path 447:5:8:8:10:8:8:18:17:25:24:24:24:24:24:25:25:25:25:25:25:25:26:27:27:27:27:27:27:27, replayPath ///A:P. Diagnosis: .superpowers sdd f7-diagnosis.md (summarised in the plan addendum). Ruling (Arthur 2026-10-03): option B — the pull sends its pending batch ids; /api/sync/changes and /api/sync/snapshot report which are already in applied_batches in the same read transaction; the replica drops those rows inside the window transaction before reapplyPending.

- [x] Server: changes/snapshot accept pending batch ids and report applied ones (same read txn), tests
- [x] OpenAPI regen
- [x] Replica/worker: drop named rows before reapplyPending, record acked seqs, return dropped ids
- [x] Queue/replicaSync: send ids, resolve dropped rows' delivery tickets, keep skipped/resync semantics
- [x] Regression tests (apply, workerHandlers, replicaSync, server) + props fixed scenario
- [x] Docs: sync-recovery.md, backend.md API table, troubleshooting row


## Summary of Changes
A pull sends its non-poisoned pending head batch ids (cap 100); /api/sync/changes and /api/sync/snapshot report which are in applied_batches from the same read transaction that hydrates the window (field omitted when empty; additive both ways). The worker drops those rows inside the window transaction before reapplyPending, records acked seqs, and the queue settles their tickets and drains on. Recovery snapshots name no ids (guarded by the synchronous poison claim and startup repair order). Commits 58782984, cbbec075, e82dcb23, 01ddb8fd, 035c4143. Residual transient drift: pkm-sj5l.
