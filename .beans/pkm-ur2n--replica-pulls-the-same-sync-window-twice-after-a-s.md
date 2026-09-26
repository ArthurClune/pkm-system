---
# pkm-ur2n
title: Replica pulls the same sync window twice after a save (WS nudge vs HTTP ack race)
status: in-progress
type: bug
priority: normal
created_at: 2026-09-26T12:31:21Z
updated_at: 2026-09-26T17:10:05Z
---

## Symptom

After most saves the replica pulls the same sync window twice. A single
debounced text edit (one `POST /api/ops`) is usually followed by
`GET /api/sync/changes?since=X` twice with the **same** `since`, plus the
authoritative `GET /api/page/…`. One of the two pulls is redundant.

## Cause

The server answers the save on two channels at once: the WS
`{"type":"seq"}` nudge and the HTTP ack of `POST /api/ops`. They arrive in
the same millisecond and the page handles them in either order:

- nudge first: `onSeq` → `pull()` → `pullLoop` reads
  `replica.pendingBatches()` while the batch is still pending
  (`web/src/sync/replicaSync.ts`, `pullLoop`, ~line 585), fetches the window,
  and meanwhile the ack's batch delete reaches the worker. `applyChanges`
  (`web/src/replica/workerHandlers.ts` ~line 290) sees the pending set
  changed and answers `pending-changed`, and `pullLoop` refetches the same
  window (`replicaSync.ts` ~632, bounded by `PENDING_CHANGED_CAP`).
- ack first: the pull snapshots an empty pending set and fetches once.

Unpinned, a probe of 10 saves saw two pulls 8 times and one pull 2 times.

## How the perf check exposed it

`perf/check.sh frontend` scenario `F/typing` counted 3 or 4 fetches run to
run (pkm-q1hh, Task 8). The check now fixes the order to nudge first with
`page.route` (`pinSaveOrder` in `web/tooling/perf/check.mjs`), so
`F/typing.api_requests` reads 4 every run: the save, the page refetch and
both pulls.

## Done when

A save that races its own nudge no longer refetches the window (e.g. the
nudge-triggered pull waits for, or ignores, the in-flight batch it caused).
A fix shows up in `perf/check.sh frontend` as an `F/typing api_requests`
improvement (4 → 3), which rewrites the baseline; commit it with the fix.

## Checklist

- [x] Server: `POST /api/ops` ack carries `seq` (journal max read inside the batch's write transaction); replay returns it verbatim
- [x] `OpsAck` contract gains optional `seq`
- [x] Pure `pendingSetStillCovered` (web/src/replica/pendingGuard.ts) + unit tests
- [x] Worker: `deleteBatch(id, ackedSeq?)` records acked seqs; `applyChanges` accepts a covered removal-only change; map pruned per call and cleared on schema rebuild
- [x] opQueue passes the ack's `seq` to `deleteBatch`
- [x] Docs: sync-and-offline.md § Windows and the pending queue, backend.md API row, frontend.md module map, troubleshooting row
- [ ] `perf/check.sh frontend` shows `F/typing api_requests` 4 → 3; commit the rewritten baseline (orchestrator)

## Summary of Changes

The save's WS nudge and its HTTP ack race: a pull that snapshotted the batch
as pending saw the ack delete its row mid-fetch and refetched the window.

- `server/src/pkm/server/routes_ops.py`: the ack is now
  `{ok, ts, applied, seq}`, `seq` read with `COALESCE(MAX(seq), 0)` inside the
  batch's own transaction before commit. Stored acks replay verbatim, so an
  old one has no `seq`; clients treat that as unknown. OpenAPI unchanged (the
  route returns a bare `dict`).
- `server/src/pkm/contracts/responses.py`: `OpsAck.seq: int | None = None`.
- `web/src/replica/pendingGuard.ts` (Functional Core): accepts a pending-set
  change only when it is removal-only, order-preserving, and every removed id
  has an acked seq ≤ the window's `latest_seq`. Safe because `sync_changes`
  reads `latest_seq` in the same read snapshot as the window rows.
- `web/src/replica/workerHandlers.ts` / `client.ts`: `deleteBatch(id, ackedSeq?)`
  (RPC payload `{id, ackedSeq}`; a bare number is still accepted). An in-memory
  `Map<rowId, seq>`; a seq-less delete forgets the id; entries outside
  `expectedPendingIds` are pruned on every `applyChanges`; `rebuildSchema`
  clears it because dropping `pending_ops` restarts AUTOINCREMENT ids.
- `web/src/sync/opQueue.ts`: reads the ack's `seq` (`ackSeq`) and passes it to
  `deleteBatch`. Other deleters (poison discard in SyncProvider) pass nothing.
- `memReplica.ts` has no pending guard; unchanged.
