---
# pkm-yvka
title: Recovery replays already-acknowledged batches over the snapshot, so a transformed op reverts the replica
status: todo
type: bug
priority: normal
created_at: 2026-09-29T13:20:35Z
updated_at: 2026-09-29T13:21:09Z
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

- [ ] Failing tests: `replicaSync` passes the acked list to `commitRecovery`; `workerHandlers` deletes acked rows and replays only the rest; content test: `[[Old]] edited` flushed, acked, snapshot carries `[[New]] edited`, replica reads `[[New]] edited` and the row is gone
- [ ] `flushBatches` collects acks (a replayed stored ack too; `seq` may be null); `RecoveryCommit` gains `acked`; the commit deletes them, then rebases the remainder (F1's carry gets the remainder)
- [ ] Docs: `sync-recovery.md` § runRecovery and § Windows and the pending queue; troubleshooting row
- [ ] verify, perf, merge
