---
# pkm-9xg0
title: Replacing a damaged replica file deletes the only copy of the pending queue before the new copy is durable
status: completed
type: bug
priority: high
created_at: 2026-09-29T13:20:25Z
updated_at: 2026-09-29T14:02:33Z
parent: pkm-a4t2
---

Review F1 (P1, introduced by pkm-1b2w). `rebaseOrReplaceFile`
(`web/src/replica/workerHandlers.ts`) unlinks the damaged replica file and
its journal, opens a fresh file, installs the schema and only then inserts the
carried pending rows. From the unlink to that commit the rows exist only in
worker memory; nothing backs up the old file and no catch restores it. The
poison repair flushes nothing first, so those rows are edits the server has
never seen. A failed open, a failed insert or a terminated worker (an iPad
suspending the PWA during startup repair) loses every row; `SyncProvider`
reports "repair-failed" and Retry rebases an empty queue, so the loss is
silent. The existing test's `discardDbFile` fake never destroys the old
database, so it cannot see the window.

Design: spec § F1 — a carry database in the same OPFS pool holds the rows
before the damaged file is touched; the fresh file imports them by id;
`init` adopts a leftover carry file; the handlers take a carry store
dependency beside `discardDbFile`.

## Todo

- [x] Failing tests: the `discardDbFile` fake replaces the db with an empty one; fail the open, the schema install and the insert in turn (rows are in the carry); a dead worker between discard and import, then fresh handlers over the same fakes, restores the rows with their ids
- [x] Carry store `{ exists, write, read, discard }` implemented in `worker.ts` over a second pool database; write before unlink, import by id after the schema, discard after the import (not the snapshot; see Summary)
- [x] Adopt-on-open (at every handler's entry, not only `init`; see Summary); `poisoned` and `error` travel with the rows
- [x] Confirm `MIN_POOL_CAPACITY` covers replica + journal + carry + journal
- [x] Docs D2: `sync-recovery.md` § Recovery never erases intent and its failure rows, § Reset, rebase and file replacement; rewrite the handler comment to state the durable boundary; troubleshooting row
- [x] verify (typecheck, lint, check:fcis, test:coverage, build; full Playwright and perf are run by the orchestrator after merge)
- [ ] perf, merge (orchestrator)

## Summary of Changes

- `web/src/replica/carryStore.ts` (new, Shell): the carry database
  (`/pkm-replica-carry.sqlite3`) over injected `CarryFiles`; `write` replaces
  its `pending_ops` in one transaction, `read` returns rows by id (none when
  the table never committed), `discard` unlinks.
- `queue.ts`: `DurablePendingRow` (moved) and `importPendingRows`, the
  `INSERT OR IGNORE` by-id import used by the carry and the new file.
- `workerHandlers.ts`: `WorkerDeps.carry`; `rebaseOrReplaceFile` writes the
  carry before `discardDbFile`, imports from it after `rebuildSchema`, and
  discards it once the import commits; without a carry store a rebase keeps
  the damaged file. Every handler goes through `queueDb`, which adopts a
  leftover carry first.
- `worker.ts`: `CarryFiles` over the SAH pool (`getFileNames`, journal-first
  unlink). `poolCapacity.ts`: `REPLICA_FILE`, `CARRY_FILE`, `journalOf`,
  `PEAK_POOL_FILES`; `MIN_POOL_CAPACITY` (6) covers the four peak files
  (TEMP_STORE=2 checked in the shipped wasm).
- Deviations from the spec: adoption at every handler's entry (an enqueue or
  local-API write can reach a restarted worker before `init` and would take
  the carried ids); the carry is discarded after the import, not after the
  snapshot (a carry kept past a failed snapshot would resurrect acked or
  deleted rows); no carry store means no replacement for a rebase.
- Tests: destroying `discardDbFile` fakes; open, schema, import and carry-write
  failures; dead worker between discard and import; enqueue before init; Retry
  in the same worker; unreadable carry; snapshot failure with no
  resurrection; composed poison repair through `replicaSync` and the real
  `Replica` facade (`replicaSync.fileReplacement.test.ts`), which also checks
  that the carry already holds the rows at the moment of unlink.
- Docs: `sync-recovery.md` (carry step table, adopt-on-entry, guard row,
  failure-table must-hold, pool note), `sync-and-offline.md` (carry file),
  `frontend.md` (module map), `troubleshooting.md` (one row).
