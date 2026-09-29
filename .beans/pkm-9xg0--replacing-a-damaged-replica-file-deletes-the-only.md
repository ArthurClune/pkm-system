---
# pkm-9xg0
title: Replacing a damaged replica file deletes the only copy of the pending queue before the new copy is durable
status: todo
type: bug
priority: high
created_at: 2026-09-29T13:20:25Z
updated_at: 2026-09-29T13:20:25Z
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

- [ ] Failing tests: the `discardDbFile` fake replaces the db with an empty one; fail the open, the schema install and the insert in turn (rows are in the carry); a dead worker between discard and import, then fresh handlers over the same fakes, restores the rows with their ids
- [ ] Carry store `{ exists, write, read, discard }` implemented in `worker.ts` over a second pool database; write before unlink, import by id after the schema, discard after the snapshot
- [ ] Adopt-on-open in `init` after the schema check; `poisoned` and `error` travel with the rows
- [ ] Confirm `MIN_POOL_CAPACITY` covers replica + journal + carry + journal
- [ ] Docs D2: `sync-recovery.md` § Recovery never erases intent and its failure rows, § Reset, rebase and file replacement; rewrite the handler comment to state the durable boundary; troubleshooting row
- [ ] verify, perf, merge
