---
# pkm-ur2n
title: Replica pulls the same sync window twice after a save (WS nudge vs HTTP ack race)
status: todo
type: bug
created_at: 2026-09-26T12:31:21Z
updated_at: 2026-09-26T12:31:21Z
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
