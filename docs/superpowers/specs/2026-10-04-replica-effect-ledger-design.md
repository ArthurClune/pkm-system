# Replica effect ledger (pkm-dbr1)

Design (c′) agreed with Arthur 2026-10-04. One change from what was agreed,
the settle rule, is in [§ Deviation from the agreed design](#deviation-from-the-agreed-design)
and needs his ruling before planning. Bean pkm-dbr1, under the
property-checks epic pkm-nws9. Line numbers are as of `a0a22a6e` on
`feat/pkm-dbr1-cross-page`.

## Problem

The web replica applies each queued batch optimistically. A create or move
also writes rows the op never names:

| Collateral write | Where |
|---|---|
| Destination siblings shifted `+1` | `shiftSiblings`, `web/src/replica/localOps.ts:106-113`, called at `:200` |
| Siblings shifted on a replay whose slot a re-shipped row took | `keepSlot`, `localOps.ts:125-139` |
| Descendants of a moved block re-paged (with `updated_at`) | `place`, `localOps.ts:218-224` |
| Descendants of a replayed create re-paged after its parent | `place`, `localOps.ts:187-193`; verdict from `placementFor`, `placement.ts:51-55` |

The server applies the same op against its own state (`plan_op`,
`server/src/pkm/server/ops_core.py:719`; `_execute`,
`ops_apply.py:390-450`), and its triggers journal only the rows it writes
(`server/src/pkm/schema.py:148-168`). `applyWindow`
(`web/src/replica/apply.ts:474-518`) upserts the rows a window ships,
drops pending rows the window already holds (`dropAppliedPending`,
`:101-110`) and replays the rest (`reapplyPending`, `:169-212`). Nothing
undoes a collateral write the server did not also make. When the two sides
place an op in different groups, the replica keeps the wrong `order_idx`
or `page_id` at rest, and a later create or move between those keys lands
in a different order than on the server.

The widened sync property finds this as a sibling `order_idx` off by one.
The fixed scenarios in `web/src/props/sync/sync.prop.ts` that fail today:

| Scenario (line) | Replica wrote | Server wrote |
|---|---|---|
| Untitled top-level move of a block another device moved to another page (432) | Shifted the old page's top level | Shifted the block's current page |
| Top-level move to a title renamed away before the pull (447); create on it (455) | Shifted the renamed page | Created a fresh page under the old title |
| Untitled top-level move of a block moved across pages and deleted elsewhere (496) | Shifted the page it saw the block on | Skipped; re-journalled the page the delete row names (`_deleted_block_page`, `ops_apply.py:231-240`) |
| Untitled top-level move after a move to another page, of a block deleted elsewhere (513) | Shifted the second page's top level | Skipped both; re-journalled the original page |
| Untitled top-level move after the batch's own move under a parent deleted elsewhere (528) | Shifted the second page's top level | Skipped the first move, applied the second on the original page |
| Move under a parent another device moved to the block's own page (544) | Re-paged the moved block's child | Re-paged nothing |

pkm-hz8w patched the skipped-op cases on the server: a skipped move journals
the destination group it guesses the replica shifted
(`_destination_siblings`, `ops_apply.py:243-275`). The guess needs page
history the server does not keep, and
[sync-recovery.md § Ops on blocks the server no longer has](../../architecture/sync-recovery.md#ops-on-blocks-the-server-no-longer-has)
lists six cases it misses. Applied ops have no such patch.

## Goals and non-goals

Goals:

- At rest, every replica row the server holds equals the server's row, for
  every create and move shape, applied or skipped, whatever group each side
  chose.
- No protocol change and no server change.
- The six fixed scenarios above and `proptest/check.sh web` pass.

Non-goals:

- **Transient states while a batch is pending.** The two accepted
  misorderings in
  [sync-recovery.md § Recovery never erases intent](../../architecture/sync-recovery.md#recovery-never-erases-intent),
  and pkm-sj5l's per-window drift, stay as they are until the batch settles
  ([§ keepSlot and pkm-sj5l](#keepslot-and-pkm-sj5l)).
- **`pages.updated_at`** touched by the local apply (`touchPage`,
  `localOps.ts:102-104`) is not reverted. It is display-only and is
  re-shipped whenever the server next writes the page.
- **Local delete cascades** need no ledger. A block the local cascade
  removes but the server keeps was moved out of the subtree by a server
  write; if that write was journalled after the replica's cursor at the
  delete, a later window ships the block back, and otherwise the replica
  already held the move and the block was not in the subtree.
- **The server's re-journalling of a skipped op's destination group
  stays**, as defence in depth (decided). Its re-shipped rows simply drop
  their ledger records early.

## The design

### Data model

A client-only table beside `pending_ops` in `CLIENT_DDL`
(`web/src/replica/clientSchema.ts:13-26`):

```sql
CREATE TABLE IF NOT EXISTS effect_ledger(
  batch_id        TEXT    NOT NULL,
  uid             TEXT    NOT NULL,
  order_delta     INTEGER NOT NULL DEFAULT 0,
  base_page_id    INTEGER,
  base_updated_at INTEGER,
  PRIMARY KEY (batch_id, uid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_effect_ledger_uid ON effect_ledger(uid);
```

| Column | Meaning |
|---|---|
| `batch_id` | The pending batch that made the write |
| `uid` | The block written collaterally |
| `order_delta` | The sum of this batch's sibling shifts of the block since its base was last set |
| `base_page_id`, `base_updated_at` | Null: no page record. Otherwise the block's page and `updated_at` before the first collateral re-page since its base was last set. Every batch's page record for one uid carries the same base |

Keyed by `batch_id`, not pending row id: `enqueueBatch` applies the ops
before it inserts the row (`queue.ts:105-115`), so the row id is unknown
when the shifts run, while the batch id is a parameter
(`queue.ts:56-57`). Both identities restart only with a rebuild, which
drops this table too.

No foreign keys, on purpose. Records outlive their pending row until the
batch settles and may name a block the local apply deleted. A ledger FK
would also appear in `PRAGMA foreign_key_check`, which `reapplyPending`
diffs around every batch (`apply.ts:172-180`).

A new module, `web/src/replica/effectLedger.ts` (Imperative Shell), holds
every statement below. `localOps.ts`, `apply.ts` and `reconcile.ts` call
it.

### Where records are written

`applyLocalOps` (`localOps.ts:296-304`) gains a required `batchId`:
`enqueueBatch` passes its own (`queue.ts:107`) and `reapplyPending` passes
`b.batch_id` (`apply.ts:178`). Required, so no caller can apply ops
unrecorded.

| Local write | Ledger |
|---|---|
| `shiftSiblings` for a create or move | Before the `UPDATE`, one `INSERT … SELECT` over the same predicate, excluding `op.uid`: `order_delta + 1` per shifted row, upserted on `(batch_id, uid)` |
| `keepSlot` when it shifts | The same, over its predicate (it already excludes `op.uid`) |
| Move re-page, create-keep re-page | For each subtree row except `op.uid`: a page record. Its base is the base any existing record for the uid carries, else the row's page and `updated_at` now. An existing record for this batch keeps its base |
| Create insert, the move's own row, `op.uid`'s own re-page | Deletes every record on `op.uid` (a direct write, below) |
| `update_text`, `set_*`, `delete`, `create_page` | None |

**Rows an op names directly are not recorded, because the server always
re-ships them.** Verified per outcome for `op.uid`:

| Server outcome | Journal row for `op.uid` | Where |
|---|---|---|
| Create applied | `InsertBlock` fires `blocks_chg_ai` | `ops_core.py:740`, `schema.py:163-165` |
| Move applied | `SetParent` fires `blocks_chg_au`, which has no `WHEN` | `ops_core.py:776-777`, `schema.py:166-168` |
| Create diverted (parent gone), blank text included | Tombstone `JournalBlock(op.uid, True, ghost_page)` | `ops_core.py:677`; the `SkipContext` return at `:686-687` still returns it |
| Move of a gone block (`orphan_structural`) | Tombstone `JournalBlock(op.uid, True)` | `ops_core.py:685` |
| Move under a gone parent, or a cycle | Every subtree row journalled live | `ops_core.py:657` |
| Rejected (400) | None: the batch is poisoned, and its repair rebases onto a snapshot, which clears the ledger | below |

So a direct write resets the block's base, and the records on it before
then describe a value the batch's echo will replace. Deleting them keeps
the invariant below exact.

Every write above runs inside the caller's transaction, under
`enqueueBatch`'s per-op savepoint (`queue.ts:105-112`) or `reapplyPending`'s
per-batch one (`apply.ts:174`, `:208`). A rollback takes the records with
the writes they describe.

### Where records are dropped

| Event | Records dropped |
|---|---|
| A window upserts a block | Every record on that uid: the server's row supersedes the local one |
| A window ships a block tombstone, applied now or deferred to the head window (`apply.ts:479-493`) | Every record on that uid. A uid that comes back ships live and is upserted |
| A pending op writes `op.uid` directly | Every record on `op.uid` |
| The batch settles | That batch's records, after the revert |
| `applySnapshot` (`apply.ts:113-139`) | All, with the table wipe. The replay that follows records again against the snapshot's rows |
| Reset, rebuild, file replacement (`workerHandlers.ts:288-338`, `:387-423`) | All: the table is dropped and recreated, or the new file starts empty |

The two window drops are one statement per window,
`DELETE FROM effect_ledger WHERE uid IN (SELECT value FROM json_each(?))`
over the window's block uids and block-tombstone uids, skipped when the
ledger is empty. The replica's SQLite is 3.53 (`web/package.json:20`), so
`json_each` is built in.

Page records name page ids, so two page paths must know them:

- `remapLocalPage` (`reconcile.ts:21-31`) also rewrites `base_page_id` from
  the local id to the server's, as it does for blocks and refs.
- `dropStrandedLocalPages` (`reconcile.ts:81-96`) keeps a negative-id page
  that a record names as a base.

### Settling a batch

**A batch settles in the first window that reaches the journal head
(`feed.next_since >= feed.latest_seq`, the `atHead` test at `apply.ts:483`)
once its pending row is gone.** A row leaves `pending_ops` four ways:

| Path | Records then |
|---|---|
| The drain's ack: `deleteBatch` (`workerHandlers.ts:440-458`, `queue.ts:186-192`) | Wait for the next head window |
| A window's `applied_batches` names it (`dropAppliedPending`) | Settle in the same window if it is at the head, else the next head window |
| A rebase commit deletes rows its flush got acks for (`workerHandlers.ts:394-397`) | Already gone: the snapshot in the same transaction clears the ledger |
| Poison repair: rebase, then `deleteBatch` with no seq (`clientRuntime.ts:116-118`) | Already gone: the rebase's snapshot cleared them |

The revert, in the window's transaction:

1. Collect the records whose `batch_id` has no `pending_ops` row. A
   poisoned row is still a row, so a poisoned batch never settles; its
   repair's snapshot clears its records.
2. Order: `order_idx -= SUM(order_delta)` per uid, one `UPDATE … FROM`.
3. Page: for each uid whose settling records carry a base and no remaining
   record does, set `page_id` and `updated_at` to the base, if that page
   exists. A uid with a remaining page record keeps its row: that batch's
   re-page still stands, and its own settle writes the same base. A missing
   page leaves the row alone rather than fail the window's deferred FK check
   at COMMIT.
4. Delete the collected records.

An `UPDATE` on a uid the replica no longer has changes nothing.

### Window order after the change

`applyWindow` (`apply.ts:474-518`), with the new steps in bold:

| # | Step | Why there |
|---|---|---|
| 1 | Page and sidebar tombstones | Unchanged: UNIQUE titles |
| 2 | Page upserts. `reconcilePage` remaps local page ids, **ledger bases included** | Unchanged |
| 3 | Block upserts | Unchanged |
| 4 | **Drop the records of every block uid the window ships live or tombstones** | Anywhere before step 9; beside the upserts it describes |
| 5 | Block tombstones, at the head window only | Unchanged |
| 6 | Sidebar upserts | Unchanged |
| 7 | Cursor, deferred-tombstone record, plain-space flag, `reconcileActivationPageTitles` | Unchanged; the last remaps ledger bases through `remapLocalPage` |
| 8 | `dropAppliedPending` | So a batch this window names settles in this window |
| 9 | **At the head window: settle every batch with no pending row** | After 7, so bases are remapped; before 10, so replays build on reverted rows |
| 10 | `reapplyPending`, recording collateral writes | Its `keepSlot` re-derives any shift a revert exposed |
| 11 | `dropStrandedLocalPages`, keeping ledger bases | After 9: a revert can put a block back on a local page |

`applySnapshot` clears the ledger with its table wipe (`apply.ts:117-122`)
and has no settle step.

### An old file before its reset

New code first opens a file whose `schema_version` is stale, and the reset
runs from `start()` (`replicaSync.ts:780-783`). Until it commits, an
online, starting session can still edit (`computeEditability`,
`syncState.ts:80-91`), and the enqueue handler leaves an existing schema
alone (`workerHandlers.ts:429-433`). An enqueue on that file would fail its
first ledger insert and roll the op's optimistic apply back. So the enqueue
handler also runs `CLIENT_DDL` when `effect_ledger` is missing. Every
statement in it is `IF NOT EXISTS`, and `schema_version` is untouched, so
the reset still runs.

No other build can run over a file that has the ledger. Code without it
computes another `SCHEMA_VERSION` and resets the file on open, and the
SAHPool VFS's exclusive handles keep two builds from holding one file at
once ([sync-and-offline.md § The replica](../../architecture/sync-and-offline.md#the-replica)).
The deferred block tombstones' cursor stamp has no counterpart here.

## Correctness

**Base.** For a block `u`, its base β(u) is the value its last
*resetting write* gave it: a window or snapshot upsert, or a pending op's
direct write. Every other write to `u`'s `order_idx` or `page_id` is a
collateral write, and every collateral write is recorded.

**Invariant.** After every statement:

- `u.order_idx = β(u).order_idx + Σ order_delta` over `u`'s records;
- if a record on `u` carries a base page, every one carries β(u)'s page;
  otherwise `u.page_id = β(u).page_id`.

| Write | Why the invariant holds after it |
|---|---|
| Upsert, tombstone, direct write | Resets β and deletes all of `u`'s records |
| Shift | Adds 1 to `order_idx` and to one record's delta |
| Re-page | Writes a page record whose base is the existing base, or, when there is none, the current page, which equals β's page by the invariant |
| Revert | Subtracts exactly the removed deltas; writes the base page only when the last page record goes |
| Savepoint or transaction rollback | Restores rows and records together |
| Local delete | The row is gone; records on a missing uid change nothing |
| Local page remap | Rewrites rows and bases alike |

**Lemma A: a batch never settles before its echo.** Let `k` commit at
`s_k`, the journal max its ack reports (`routes_ops.py:79-80`). Every
window the replica applies after `k`'s row is gone has `latest_seq ≥ s_k`:

- a window whose pending snapshot predates the deletion applies only if
  `pendingSetStillCovered` finds `k`'s acked seq at or below `latest_seq`
  (`pendingGuard.ts:28-44`), and an unknown seq is never covered;
- a window snapshotted after the deletion was read after the commit, since
  a row is deleted only on an ack or on a read that holds the batch;
- a window that drops `k` itself read `k`'s commit (`AppliedBatch`,
  `responses.py:392-401`).

At the head window `next_since ≥ latest_seq ≥ s_k`, so every journal row
of `k`'s commit has been applied.

**Lemma B: what survives is what the server left alone.** A record of `k`
on `u` surviving to `k`'s settle means no window shipped `u` and no op wrote
`u` directly since the record was written. The server's triggers journal
every write (`schema.py:148-168`), and by Lemma A every journal row up to
`k`'s commit has been applied. So `k`'s commit did not write `u`, and β(u)
is either the server's row as of the cursor (set by an upsert) or the
optimistic value of a batch that commits after `k`, whose echo re-ships
`u`. Reverting gives β(u) plus the records of batches still pending: the
server's state plus their collateral writes, which is what `reapplyPending`
builds on next.

**Convergence.** At quiescence no row is pending, a head window has been
applied since the last deletion, so no record remains, and every row equals
its base. Each base is the server's current row. A base set by an upsert
saw every later server change shipped again, since the cursor is at the
head. A base set by a direct write of batch `j` was reset since by `j`'s
echo, which by the table above always ships or tombstones `op.uid`.

The proof needs no claim about when records are written relative to the
server's commit, so it covers a batch replayed over its own echo, as
happens past `PENDING_IDS_CAP` (`replicaSync.ts:126`): the replay's
collateral writes are recorded and reverted at settle. Its direct writes
are still the documented gap.

### Several pending batches

Deltas add, so reverting one batch removes only its own. The example below
is the shape the property finds, with a second batch behind the first:

Page P holds `m@0 a@1 r@2`. Another device moved `m` to page S; this
replica has not pulled that. Batch b1 is an untitled top-level move of `m`
to 1; b2 is a top-level create of `X` on P at 3.

| Moment | Replica P (records) | Server P |
|---|---|---|
| Enqueue b1 | `m1 a2 r3` (b1: a+1, r+1) | `a1 r2` |
| Enqueue b2 | `m1 a2 X3 r4` (b1: a+1, r+1; b2: r+1) | `a1 r2` |
| b1 commits: the server moves `m` on S | | `a1 r2` |
| Head window ships `m` (now on S); b1 settles | `a1 X3 r3` (b2: r+1) | |
| Same window: replay b2, `keepSlot` finds `r` on X's slot | `a1 X3 r4` (b2: r+2) | |
| b2 commits: creates X at 3; `r@2` is below the slot | | `a1 r2 X3` |
| Head window ships X; b2 settles | `a1 r2 X3` | `a1 r2 X3` |

Without the ledger the replica ends at `a2 X3 r4`, so `r` and `X` swap
places.

Page bases are shared rather than chained. If b1 and b2 both re-page a
descendant D off page A, both records carry base A. b1's settle leaves D on
b2's page while b2's record remains, and b2's settle writes A unless a
window shipped D first. If b1's later replay had overwritten b2's page, D
shows b1's page until b2's replay re-derives it or b2 settles: a transient,
like the others in the non-goals.

### Replays

A replay records only the writes it makes. One that keeps its op in place
writes nothing and records nothing. One that shifts, because `keepSlot`
found a clash or a move is no longer in place, adds to its batch's delta.
A batch's page record keeps its first base, so a replay that re-pages again
cannot overwrite it. There is no double counting to avoid: the ledger
counts writes, not ops.

### keepSlot and pkm-sj5l

The ledger does not stop pkm-sj5l. A pending `[move s4 0; move s4 1]`
still shifts its siblings again on every window that lacks it, and each
shift is recorded. What changes is the heal:

| Server applied the batch | Today | With the ledger |
|---|---|---|
| To the same group | The echo re-ships the siblings | The same; the upserts drop the records |
| To another group | The drift stays for good | The settle reverts the accumulated delta |

So pkm-sj5l stays open as a transient that now always ends at settle. The
ledger also names exactly the rows a pending batch has touched, which is
what sj5l's "skip a replay when the window re-shipped none of its rows"
idea needs.

## Deviation from the agreed design

The agreed design settled a batch once it was acked and the cursor had
reached its ack's seq, and so stored the ack seq durably (it lives only in
`ackedSeqs`, in memory, `workerHandlers.ts:248-263`), with seq-less acks
settling at the head window. This spec settles every batch at the head
window and stores no ack state. Lemma A shows the head window is always
late enough. Every pull ends with one: `pullLoop` fetches at least one
window and loops until `next_since >= latest_seq`
(`replicaSync.ts:650-736`). A batch with records always journals rows when
it commits, so its ack is always followed by a pull with a window to apply.

The seq would settle a batch one or more windows sooner, and only during
a catch-up over several windows. It would cost a durable write on both
ack paths and a second settle rule. The seq-less ack it had to handle only
arises for an ack stored before `OpsAck.seq` existed (`responses.py:585`,
added in `758103b3` on 2026-09-26; replayed verbatim by
`routes_ops.py:64-67`), which no batch enqueued under the ledger can have,
since its batch id is fresh. The poison repair's `deleteBatch` without a
seq (`clientRuntime.ts:117`) follows a snapshot, so it has nothing to
settle either way.

## Migration

Adding the table changes `CLIENT_DDL`, so `SCHEMA_VERSION`
(`clientSchema.ts:30`) changes and each replica runs the schema-change
recovery once on its first load after the deploy: `recover("reset")`
(`replicaSync.ts:780-783`), which flushes pending rows to the server,
fetches a snapshot, drops and rebuilds every replica table, and applies it.
The ledger itself does not need the reset (an empty ledger is valid for any
state); the hash forces it.

What users see, once per device and browser profile:

| At that load | What happens |
|---|---|
| Online | The replica stays `starting` while the flush, snapshot download and rebuild run, as on a new device's first load (`H/cold`'s `replica_ready_ms`), then `ready`. Editing stays enabled while connected |
| Offline | The flush or snapshot fails: mode `recovery-failed`, read-only with "local data recovery failed — reconnect to continue" (`syncState.ts:86-87`), until a reconnect re-runs `start()` |

Earlier base-schema changes (`block_refs`, 2026-08-06) took the same path.

## Performance

| Cost | When |
|---|---|
| One `INSERT … SELECT` per sibling shift, beside the shift's `UPDATE` | Every create or move, at enqueue and on a replay that shifts |
| One page-record statement per re-paged descendant | A cross-page move, or a replayed create following its parent |
| One indexed `DELETE` per direct write | Every create or move |
| One emptiness probe per window; one `DELETE … json_each` when the ledger has rows and the window ships blocks | Every window |
| Three set-based statements and a `DELETE` | A head window with a batch to settle |
| One `DELETE` | Every snapshot |

With nothing pending the ledger is empty and a window costs one probe.

`perf/check.sh frontend` gates counts of fetches, requests, renders, forced
layouts and long tasks, none of which this changes; worker SQL is not
counted. `F/typing`, `J/journal-typing` and `I/journal-scroll` send
`update_text` only, which records nothing. Timings that could move, flagged
only on a clear worsening: `H/cold`'s `replica_ready_ms` (the snapshot's
extra `DELETE` on an empty table) and `W/warm`'s `first_outline_ms` (one
probe per window). There is no server change, so the backend side is not
picked and `openapi.json` needs no regeneration.

## Testing

Unit tests in vitest, written first, beside the code:

| File | Cases |
|---|---|
| `effectLedger.test.ts` (new) | A shift records `+1` per shifted row and nothing for `op.uid`; a second shift by the same batch adds; a page record copies an existing base, and a batch's record keeps its first; a direct write deletes every record on its uid; settle reverts the order sum, writes the base page and `updated_at` only when the last page record goes, leaves a row whose base page is gone, and changes nothing for a missing uid |
| `localOps.test.ts` | A create; a move within one group; a cross-page move (siblings recorded, descendants page-recorded, root not); a replay that keeps records nothing; a replay whose `keepSlot` clashes records; a replay of a move not in place adds to the delta |
| `apply.test.ts` | A window upsert and a block tombstone, applied and deferred, drop records; no revert while the row is pending, nor in a window short of the head; revert at the head after `deleteBatch`; revert in the window whose `applied_batches` names the batch, before `reapplyPending`; a poisoned batch never settles; the two-batch table above, row by row; a batch rolled back in `reapplyPending` (throw and FK paths) leaves only its earlier records; `applySnapshot` clears the ledger and its replay records again; a window rollback (`StaleTitleHolderError`) leaves the ledger as it was |
| `apply.test.ts`, one case per fixed scenario | The six shapes above, as window sequences against a seeded replica, each ending equal to the server's rows |
| `reconcile.test.ts`, `applyLocalPages.test.ts` | `remapLocalPage` rewrites bases; `dropStrandedLocalPages` keeps a page a record names, and drops it after the settle |
| `workerHandlers.test.ts` | `deleteBatch` without a seq, then a head window, reverts; an enqueue on a file without `effect_ledger` creates it, records, and leaves `schema_version` stale |
| `clientSchema.test.ts` | `installSchema` creates the table and index |

Then:

- The six fixed scenarios pass: `proptest/check.sh web` runs them before
  the property.
- The full `proptest/check.sh web` passes. The server side is not picked,
  since nothing under `server/` changes.
- `cd web && pnpm verify`.
- `perf/check.sh frontend`, with its table in the final review package.

## Docs to update

| Doc | Change |
|---|---|
| `docs/architecture/sync-recovery.md` § Recovery never erases intent | Reverse "Nothing wrong is stored, and a fix would mean keeping pre-images of every row a pending op touches": the ledger keeps the pre-images of collateral writes, and the settle restores them. Add a guard row for it. The two transient misorderings stay. Correct the sj5l paragraph to "until the batch settles" |
| `docs/architecture/sync-recovery.md` § Ops on blocks the server no longer has | Delete the Known gaps table: the ledger reverts every case in it. One sentence: the server's re-journalling of the destination group remains as defence in depth |
| `docs/architecture/sync-recovery.md`, new subsection under Windows and the pending queue | The ledger: what is recorded, the drop table, the settle rule and Lemma A, as a table and a short ordered list, not this spec's proof |
| `docs/architecture/sync-and-offline.md` § The changes feed | The `applyWindow` step table becomes the eleven steps above, including `dropStrandedLocalPages` (pkm-wj9b, on this branch). § The replica: the client-only tables include `effect_ledger` |
| `docs/architecture/frontend.md` | `effectLedger.ts` in the module map |
| `docs/architecture/backend.md` § Missing targets | The destination-sibling journalling is defence in depth for replicas |
| `docs/architecture/backend.md` § The write path | The rename and merge paths read the referencing blocks inside their write transaction (pkm-xtqz, on this branch) |
| `docs/troubleshooting.md` § Sync and offline | Rewrite the pkm-hz8w row's last sentence: the applied-op case is fixed by pkm-dbr1. New row for pkm-dbr1: symptom (sibling keys off by one, or a descendant on the wrong page, after a create or move the two sides placed in different groups), cause, fix. Update the pkm-sj5l row: the drift now ends at settle in every case. New rows for pkm-wj9b (an empty local page the server never made or renamed) and pkm-xtqz (a link not rewritten by a rename racing a batch) |

Every edit under `docs/architecture/` goes through the `architecture-docs`
skill.

## Files

| File | Change |
|---|---|
| `web/src/replica/clientSchema.ts` | `effect_ledger` and its index in `CLIENT_DDL` |
| `web/src/replica/effectLedger.ts` (+ test) | New: record, drop, settle, clear, remap |
| `web/src/replica/localOps.ts` | Required `batchId`; recording at each collateral write; drop on each direct write |
| `web/src/replica/queue.ts` | `enqueueBatch` passes its batch id |
| `web/src/replica/apply.ts` | Steps 4 and 9; `reapplyPending` passes `b.batch_id`; `applySnapshot` clears the ledger |
| `web/src/replica/reconcile.ts` | `remapLocalPage` remaps bases; `dropStrandedLocalPages` keeps them |
| `web/src/replica/workerHandlers.ts` | The enqueue handler installs a missing ledger |
| Tests listed above, and the docs | |

## Rejected alternatives

| Alternative | Why not |
|---|---|
| (a) The server re-journals more sibling groups | No bounded set suffices without page and title history plus each client's cursor |
| (b) Ops declare `placed_page_id` | A protocol change, and it misses drift a replay introduces after enqueue |
| (c″) A route to re-fetch a sibling group | Duplicates the window's hydration and ordering logic |
| (d) The ack carries the rows' state | Stale under a stored-ack replay, which returns the commit-time ack |
| The ledger as JSON in `sync_client_meta` | Decided against: a whole-value rewrite per shift and no per-uid index for the window drop |
| Pre-images of every row a pending op writes, direct rows included | The echo always re-ships direct rows, so those records would be written and dropped for nothing |
| Settle on the ack seq | See [§ Deviation from the agreed design](#deviation-from-the-agreed-design) |

## Open questions

- The head-window settle rule in place of the durable ack seq needs
  Arthur's ruling.
