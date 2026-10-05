# Replica delete cascade (pkm-jarz)

Design agreed with Arthur 2026-10-05 (option 1: the effect ledger records a
local delete's cascaded rows). Bean pkm-jarz, under the property-checks epic
pkm-nws9. Line numbers are as of `c59bb1d8` on `main`.

## Problem

A local `delete` removes the block and its whole local subtree
(`web/src/replica/localOps.ts:264-270`). The server applies the delete to its
own tree. When another device moved a descendant out first, the server keeps
that descendant and everything under it.

Take P > K > G. Device C moves K out of P. This replica, offline, deletes P;
the local apply removes P, K and G. On the server the delete removes P alone.
The feed then ships K's row (C's move) and P's tombstone. G's row never
changed: a same-page move journals only the moved row (`SetParent`,
`server/src/pkm/server/ops_core.py:777`). Nothing re-ships G, so the replica
lacks it until its next snapshot.

The [replay log (formerly the effect ledger)](../../architecture/sync-recovery.md#the-replay-log)
already takes back the collateral writes a pending batch made to rows the op
never names (sibling shifts, descendant re-pages). A cascaded delete is one
more such write, and the ledger does not record it.

pkm-pp7q and pkm-d3qh fixed the same symptom for the feed's own tombstone
cascade (their rows in [docs/troubleshooting.md](../../troubleshooting.md)).
This is the third path: the replica's own optimistic cascade.

The bean holds the deterministic two-client scenario (S1), a control and a
variant. S1 fails 3/3 on `main`; the control passes.

## Goals and non-goals

Goals:

- At rest, a block the server kept is on the replica after a local delete of
  one of its ancestors, whatever moved it out and whichever device did.
- No wire change and no server change.
- S1, its control and its variant pass as fixed scenarios in
  `web/src/props/sync/sync.prop.ts`, and `proptest/check.sh web` is green.

Non-goals:

- Showing the kept block before the delete settles. It is missing from the
  local delete until the head window after the ack, the same accepted
  transient as the other ledger reverts.
- Server-side journalling of survivors (rejected in pkm-dbr1 as option (a),
  "the server re-journals more groups"), and hiding descendants instead of
  deleting them (rejected in pkm-d3qh).

## The design

### Data model

One nullable column on `effect_ledger` (`clientSchema.ts:27-34`):

```sql
row_json TEXT
```

A record with `row_json` set is a **row record**: the block was removed by
a cascade of that batch's delete. Its fields:

| Column | Holds |
|---|---|
| `row_json` | JSON of the block's base row except `uid` and `page_id`: `parent_uid`, `order_idx`, `text`, `heading`, `collapsed`, `created_at`, `updated_at`, `view_type` |
| `base_page_id` | The base page |
| `base_updated_at` | Unused for a row record (`row_json` holds `updated_at`); left NULL |
| `order_delta` | 0 |

Keeping the page in `base_page_id` means `remapBasePage`
(`effectLedger.ts:100-106`), `dropStrandedLocalPages`
(`reconcile.ts:87-92`) and every other reader of ledger bases cover the row
record with no change.

"Base" has the ledger's existing meaning (`effectLedger.ts:10-16`): the value
the row's last resetting write gave it, without any pending batch's
collateral writes. At capture:

- `order_idx` = current `order_idx` − the sum of `order_delta` over every
  record on that uid;
- `page_id` = the `base_page_id` any record on that uid already carries,
  else the current `page_id`; `updated_at` likewise from `base_updated_at`.

### Where records are written

In the `delete` case of `applyOne`, before the `DELETE` of each uid other
than `op.uid` (the op names the root; its tombstone always comes back,
applied or skipped). A new `recordCascade(db, batchId, uid)` in
`effectLedger.ts`:

1. reads the row and the uid's existing records, and computes the base as
   above;
2. deletes every record on that uid (all batches);
3. inserts this batch's row record.

Step 2 is the absorb rule. The base already has the earlier batches'
deltas and page records taken out. If they stayed, an earlier batch settling
after this row was restored would subtract a shift a second time, or move
the restored row to a stale page.

Neither `refs` nor `block_refs` is stored; the restore derives both from
`text`. A stored `refs` row would name a page by id, and a local
(negative) id inside `row_json` is out of `remapBasePage`'s reach, so a
restore after the page reconciled would lose the ref.

The replay (`reapplyPending`, `apply.ts:172`) runs the same code, so a
replayed delete records the rows a window re-shipped under the deleted
block, from their server values.

### Where records are dropped

Unchanged. Every existing rule applies to row records as it does to the
others:

| Event | Effect on a row record |
|---|---|
| A window ships the uid live or tombstoned (`dropWindowRecords`, `apply.ts:511-514`) | Dropped. A block the server deleted in the cascade gets its own delete row and tombstone, so the common case clears itself |
| A pending create or move places the uid (`dropRecordsOf`) | Dropped. An undo of the delete re-creates its blocks with their uids |
| A later cascade of the same uid | Replaced by the absorb rule |
| The batch settles | Dropped after the restore below |
| Snapshot, reset, rebuild or file replacement (`clearLedger`) | Dropped |

### Settling: the restore

`settleBatches` (`effectLedger.ts:76-93`) runs its two reverts as today,
with the page revert restricted to records whose `row_json IS NULL`. Then,
before its final `DELETE`, it restores the row records of the settling
batches:

- **Rounds, parents first.** In each round, insert every settling row
  record whose uid is absent and whose parent is present (or whose
  `parent_uid` is NULL and whose base page exists). Repeat until a round
  inserts nothing. Records are captured against different roots and
  batches, so a capture-time depth is not comparable across them; the
  rounds do not need one.
- **The insert** writes the block row from the base row. A row with a
  parent takes the parent's `page_id`, not its base page. The FTS insert
  trigger indexes the text. `reindexBlockRefs` derives `block_refs` and
  returns the parsed page refs; each becomes a `refs` row when a page of
  that title exists on the replica, looked up as `getOrCreateLocalPage`
  looks one up, and is skipped otherwise. The restore never mints a page:
  it runs inside a window, and the server, which holds the block, holds its
  ref targets too, so they have reached the replica by the head window.
- **Lookup by title without `localOps.ts`.** `localOps.ts` imports
  `effectLedger.ts`, so the title lookup (`storedPageTitle`,
  `localPageTitle`, `pageIdByTitle`, `existingLocalPageId`,
  `localOps.ts:51-70`) moves to a new `replica/pageLookup.ts`, imported by
  both.
- **A record that never qualifies is dropped**, not restored. A record's
  parent is absent at a head window only when a still-pending batch deleted
  it locally. That delete will reach the server and remove this block with
  it, or find the block moved out, in which case the move ships the block.
- No page `updated_at` is touched, as a revert never touches one.

Why restoring at settle is safe is the ledger's existing argument
(sync-recovery.md § The effect ledger): a head window applied after the
batch's pending row is gone has `latest_seq` at or past the batch's commit.
Every block the server deleted in that commit, or since, has had its
tombstone shipped, and that dropped its record. A row record still standing
names a block the server held at the head, with the base row unchanged since
(any server write to it would have shipped it).

### Window order

No change to `applyWindow`'s steps
([sync-and-offline.md](../../architecture/sync-and-offline.md#the-changes-feed)).
The restore runs inside step 9 (`settleBatches`), so:

- it follows step 5, the head window's block tombstones, so it cannot put
  back a block whose tombstone ships in this window (that record was dropped
  at step 4);
- it follows step 7, so page bases are remapped;
- it precedes step 10, so a still-pending batch's replay builds on restored
  rows and records them again if it cascades them;
- it precedes step 11, so a restored row on a local page keeps that page.

### An old file before its reset

New code first opens a file built with the old `CLIENT_DDL` and resets it
from `start()`; until then an enqueue still applies optimistically
(sync-recovery.md § The effect ledger). That file's `effect_ledger` lacks
`row_json`, so a delete's first row-record insert would fail and roll the
op's optimistic apply back. The enqueue guard (`workerHandlers.ts:434-436`)
widens: when `effect_ledger` is missing, run `CLIENT_DDL` as today; when it
exists without `row_json`, `ALTER TABLE effect_ledger ADD COLUMN row_json
TEXT`. `schema_version` is untouched, so the reset still runs and rebuilds
the table from `CLIENT_DDL`.

### Views

A restore rides the window that settles the batch. In practice that is the
window carrying the batch's echo (it names the batch in `applied_batches`,
so step 8 drops the row and step 9 settles it), which advances the cursor
and so `appliedVersion`. This is the same signal the existing reverts rely
on; nothing new is added.

## Correctness

### The scenarios

| Scenario | What happens |
|---|---|
| S1: A deletes sec_1 (> sec_3 > seed_1) offline; C moves sec_3 out | A's apply records sec_3 and seed_1. The window ships sec_3 (record dropped) and sec_1's tombstone, and names A's batch. Settle restores seed_1 under sec_3 |
| Control: A's cursor is behind its own nesting echo | The window re-ships seed_1 from A's earlier move; its record drops at step 4 and the upsert restores it. Settle has nothing left |
| Variant: the nesting came from C | As S1 |
| No other device: A deletes P > K > G | The server cascades K and G; their tombstones drop both records. Settle restores nothing |

### Several pending batches

- Batch 1 shifts G; batch 2 deletes P, cascading G. The row record's base has
  batch 1's delta taken out, and batch 1's record is absorbed. Batch 1
  settling first does nothing to G (absent, no record); batch 2 settling
  restores the base row.
- Batch 1 deletes P (records K, G); a window ships K, moved out by C; batch 2
  deletes K. G is already gone locally, so batch 2 records nothing for G. At
  batch 1's settle K is absent, so G's record is dropped. Batch 2's delete of
  K cascades G on the server, which ships G's tombstone.
- Batch 1 deletes P; batch 2 is the undo, re-creating P, K, G. Batch 2's
  creates drop the records; nothing is restored twice.

### Replays

A windowed replay of a pending delete re-runs the cascade over the window's
rows. Rows still absent are not reached. A row the window re-shipped is
reached and recorded afresh from its server values; its old record was
dropped at step 4.

## Migration

Adding the column changes `CLIENT_DDL`, so `SCHEMA_VERSION` changes and each
replica runs the schema-change recovery once on its first load after the
deploy (flush, snapshot, rebuild), exactly as the ledger's own introduction
did (see `2026-10-04-replica-effect-ledger-design.md § Migration`).

## Performance

| Cost | When |
|---|---|
| One read of row and records, one `DELETE`, one `INSERT` per cascaded descendant | A delete with descendants, at enqueue and on a replay that reaches them |
| One extra predicate on the page revert; one probe for settling row records | A head window with a batch to settle |
| One insert round per tree level of restored rows | Only when a restore happens |

`perf/check.sh frontend` counts none of this (worker SQL is not counted);
the typing scenarios send `update_text` only. No server change, so no
backend perf run and no `openapi.json` regeneration.

## Testing

- **Fixed scenarios** in `web/src/props/sync/sync.prop.ts`: S1, its control
  and its variant, copied from the bean.
- **Unit tests** beside the code (`effectLedger.test.ts`,
  `localOps.test.ts`, `apply.test.ts`):
  - a delete with descendants records each descendant and not the root;
  - the base subtracts pending deltas and takes an existing page base; the
    other records on that uid are absorbed;
  - settle restores a standing row record with its refs (pages present
    only, none minted), block refs and FTS row, parents before children,
    under its parent's page;
  - a tombstone, a live re-ship or a re-create drops the record, and settle
    restores nothing;
  - a record whose parent is absent is dropped;
  - `remapBasePage` rewrites a row record's page;
  - `dropStrandedLocalPages` keeps a local page a row record names;
  - the enqueue guard adds `row_json` to an old file's ledger.
- **Gates:** `pnpm verify`, `proptest/check.sh web`, `perf/check.sh frontend`.

## Docs

- `sync-recovery.md § The effect ledger`: the row-record write and the
  restore in its tables and settle paragraph; the guard row in "Recovery
  never erases intent" names cascades.
- `sync-and-offline.md`: step 9's note mentions the restore.
- `docs/troubleshooting.md`: one row (symptom, cause, owning section,
  pkm-jarz).
