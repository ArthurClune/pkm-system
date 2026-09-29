---
# pkm-yvka
title: Recovery replays already-acknowledged batches over the snapshot, so a transformed op reverts the replica
status: completed
type: bug
priority: normal
created_at: 2026-09-29T13:20:35Z
updated_at: 2026-09-29T15:37:21Z
parent: pkm-a4t2
blocked_by:
    - pkm-9xg0
---

Review F6 (P2, pre-existing; Astra C5). `runRecovery` pauses, takes the
lease and fingerprints the rows, flushes each batch and discards the ack
without deleting rows, fetches the snapshot and commits; the worker applies
the snapshot and `reapplyPending` replays every non-poisoned row as an
unconditional `UPDATE`. Rows are deleted only after resume, when the drain
re-POSTs the same `batch_id` and the server returns the stored ack. Where the
server's result differs from the wire op — rename replay turning `[[Old]]`
into `[[New]]`, a conflict landing, another device writing the block between
flush and snapshot — the replica ends with the wire text; the next pull
starts at the snapshot seq so the journal row never returns and own echoes
are dropped. Scope: `recover("rebase")` with flush "preemptible"
(needs-bootstrap, window-strikes). The poison rebase flushes nothing, so its
replay is right. The pending-id guard and `ackedSeqs` are about feed windows
and are not read by snapshot application.

Design: spec § F6 — `flushBatches` records `{ id, batch_id, seq }` for each
acknowledged batch; `runRecovery` passes the list as `acked` in
`commitRecovery`; after the fingerprint check the worker deletes those rows
with `deleteBatch`'s bookkeeping and carries and replays only the rest. The
fingerprint stays as it is. Blocked by F1: both rewrite the rebase commit path.

## Todo

- [x] Failing tests: `replicaSync` passes the acked list to `commitRecovery`; `workerHandlers` deletes acked rows and replays only the rest; content test: `[[Old]] edited` flushed, acked, snapshot carries `[[New]] edited`, replica reads `[[New]] edited` and the row is gone
- [x] `flushBatches` collects acks (a replayed stored ack too; `seq` may be null); `RecoveryCommit` gains `acked`; the commit deletes them, then rebases the remainder (F1's carry gets the remainder)
- [x] Docs: `sync-recovery.md` § runRecovery and § Windows and the pending queue; troubleshooting row
- [x] verify (typecheck, lint, check:fcis, test:coverage, build)
- [ ] perf, merge (orchestrator)

## Summary of Changes

- `replicaSync.flushBatches` holds every `/api/ops` ack as `{ id, batch_id, seq }` in a closure list `heldAcks` (`seq` from `ackSeq`, moved unchanged into the Functional Core `sync/opsAck.ts`; null for a stored ack without it). The next `commitRecovery`, whatever its kind, takes the list; a `rebase` passes it as `acked`, a `reset` passes none (it drops `pending_ops`). A run that ends before its commit (preempted flush, failed snapshot fetch) leaves the acks for the next run, so the poison rebase after a preemption deletes the rows the preempted flush got acks for.
- Beyond the plan: a commit that fails hands its acks back to `heldAcks`, since the rows are still queued; the id-and-batch_id match keeps a stale entry harmless.
- `RecoveryCommit`'s rebase variant gains required `acked: readonly AckedBatch[]` (typecheck catches any call site that omits it).
- Worker: `splitAckedRows` (`replica/ackedRows.ts`, Functional Core) settles a row only when both `id` and `batch_id` match; unmatched entries are ignored. `rebaseOrReplaceFile` deletes the settled rows and applies the snapshot in one `ReplicaDb.transaction`, so a failed snapshot rolls the deletes back, then records their seqs through the new `noteAck` (shared with the `deleteBatch` handler). On F1's replacement path the carry receives only the remaining rows and no ack is recorded (the rebuild clears `ackedSeqs`, and ids may be reused). All F1 guarantees and tests unchanged apart from `acked: []` inputs.
- Decisions (from the plan): acks outlive a run that ends before its commit; deletes share the snapshot's transaction; `ackedSeqs` recorded only on the in-place commit; `acked` required on the rebase variant only.
- Docs: `sync-recovery.md` (runRecovery flowchart and ack hand-off table, guard row, `ackedSeqs` paragraph, carry wording and step 1), `frontend.md` module map, one `troubleshooting.md` row.
- Tests: composed `replicaSync.ackedReplay.test.ts`; 4 `ackedRows` tests; 7 worker commit tests; 4 replicaSync tests; 1 `opsAck` test. Web unit suite 183 files / 2844 tests green with coverage thresholds met.
