# Replica replay as a rebase (pkm-j3ui, closes pkm-sj5l)

Design agreed with Arthur 2026-10-05: option (a), a pre-image log that
replaces the effect ledger; replay stamps with the enqueue time; replay skips
per op; poisoned batches are rewound, not replayed. Found by the op
divergence property's check R
([spec](2026-10-05-property-checks-op-divergence-design.md)). Line numbers
are as of `0a4f2845` on `feat/pkm-j3ui-op-divergence`.

## Problem

Every feed window upserts the server's rows and then replays each pending
batch over the replica (`apply.ts reapplyPending`, `:172-215`) with
`reapply: true`. Replay cannot take back what the batch already did, so it
"keeps": a create whose uid exists stays where it is, and a move already at
its target stays (`placement.ts:51-55`, `:69-72`); `keepSlot` shifts siblings
only on a slot clash (`localOps.ts:111-124`).

Keeping is not a first apply. The property's shrunk examples, each where the
server and a fresh first apply agree and the replayed replica does not:

| Shape | Pending batch | Window | First apply | Replay |
|---|---|---|---|---|
| Order (B) | create X at 0, move X to 1 | ships Y at 0 | X, Y | Y, X |
| Phantom create (D) | create C under P, move C to top | deletes P | both skipped | C kept |
| Phantom page (E) | move B to top of `Ops Four` (minted locally) | deletes B | no page | `Ops Four` kept |
| pkm-sj5l | move s 0, move s 1 | lacks the batch | siblings +1 | siblings +2 per window |

The root: the effect ledger (`effectLedger.ts`) records a pending batch's
**collateral** writes (sibling shifts, descendant re-pages, cascaded rows) so
settle can take them back, but nothing records its **direct** writes: the
created row, the moved row's prior place, text and field edits, minted local
pages, refs and `pages.updated_at` (`localOps.ts:53-84`, `:189-275`). Direct
writes even delete existing records (`dropRecordsOf`, `:178`, `:196`,
`:207`). The ledger spec's reason, "the echo always re-ships direct rows",
holds at settle but not for a replay over a window that lacks the batch.

## Decisions

| Question | Ruling |
|---|---|
| Mechanism | One pre-image log replaces `effect_ledger`; every window rewinds pending batches before it applies, then replays them as a first apply. Rejected: (c) keep the ledger and add a trigger undo log for pending batches (two mechanisms, and the undo log must undo the ledger's own bookkeeping); (b) a shadow base table (needs acked batches' ops replayed; breaks on hydrated windows) |
| Recorder | Explicit calls in `localOps.ts`, not temp triggers (hidden behaviour, DDL on every enqueue) and not the SQLite session API (outside `ReplicaDb`, opaque changesets cannot be pruned per uid) |
| Replay clock | Each batch's enqueue time, so a pending row is stamped as its first apply stamped it, not re-stamped every window |
| A failing op on replay | Skipped alone, as `enqueueBatch` skips it (`queue.ts:105-112`); today replay rolls the whole batch back |
| Poisoned batches | Rewound at the next window and never replayed: their optimistic effects leave when the server's verdict is known, not at the repair snapshot |

## Design

### The log

`CLIENT_DDL` replaces `effect_ledger` with:

```
replay_log(
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- 'block' | 'page'
  key         TEXT NOT NULL,          -- uid, or page id as text
  pre_json    TEXT,                   -- the row before the batch first touched it; NULL = absent
  pre_page_id INTEGER,                -- a block pre-image's page, remappable
  UNIQUE(batch_id, kind, key)
)
replay_log_refs(log_id INTEGER NOT NULL, target_page_id INTEGER NOT NULL, kind TEXT NOT NULL)
replay_batches(batch_id TEXT PRIMARY KEY, enqueued_ms INTEGER NOT NULL)
```

with an index on `replay_log(kind, key)`. A block pre-image holds every
`blocks` column but `page_id` (kept in `pre_page_id`); its refs rows go to
`replay_log_refs`, because they carry page ids `remapLocalPage` must reach.
`block_refs` and FTS are derived from the restored text, never stored. A page
pre-image holds `updated_at`, or is absent for a page the batch minted.

**Recording** (`replica/replayLog.ts`, Imperative Shell): `INSERT OR IGNORE`
of the pre-image before every write `localOps.ts` makes, so the first touch
per batch wins: the sibling shift (one statement over the shifted set), the
re-page and delete-subtree loops, the insert, the move, `update_text` and the
`set_*` writes, `touchPage`, and `getOrCreateLocalPage` when it mints (it
gains an optional batch id; reads that mint daily pages pass none and are not
recorded). `enqueueBatch` writes `replay_batches`.

Gone: `dropRecordsOf`, `keepSlot`, the `reapply` parameter and the keep
verdicts in `placement.ts`, `recordShift`/`recordRepage`/`recordCascade`,
`settleBatches`, `restoreRows`.

### Rewind

`rewind(db, scope)` restores, for each `(kind, key)` with records in scope,
the record with the lowest `id` (the oldest batch's first touch), then
deletes the records in scope:

1. rows present with a pre-image: `UPDATE` from it (blocks, then their refs
   replaced from `replay_log_refs`, skipping pages that no longer exist;
   `block_refs` re-derived where the text changed);
2. rows absent with a pre-image: `INSERT` in rounds, parents first, each
   round only rows whose parent and page are present (today's `restoreRows`
   rule); a row whose parent never appears is dropped;
3. rows whose pre-image is absent: `DELETE`, last, deepest first, so children
   restored elsewhere are out of the way before any cascade;
4. pages: an absent pre-image deletes a minted local page that nothing
   references; otherwise `updated_at` is restored.

Never `REPLACE`: with `recursive_triggers=ON` (`worker.ts:40`) its implicit
delete fires the delete triggers and FK cascades.

### The window

Inside `applyWindow`'s one transaction (`apply.ts:492-543`), the new order:

| Step | Change |
|---|---|
| `PRAGMA defer_foreign_keys = ON` | unchanged, still first |
| `dropAppliedPending` | moved up: it only deletes queue rows |
| `rewind(pending)` | new: every batch still in `pending_ops`, poisoned included; at the head window, every record (acked batches' too: today's settle) |
| page and sidebar tombstones, pages, blocks | unchanged |
| `dropWindowRecords` | now over `replay_log`: drops records on what the window shipped or owes. Only acked batches' records can remain here, and only short of the head |
| block tombstones (head only) | unchanged; they now cascade over a tree with no pending effects |
| sidebar, cursor, activation reconcile | unchanged |
| replay | each non-poisoned pending batch, in queue order, as a first apply at its `enqueued_ms`, recording afresh; op by op, each under a savepoint with the FK diff, a throwing or FK-adding op skipped alone |
| `dropStrandedLocalPages` (head only) | the exemption for titles a pending batch names goes: a replay that still needs the page re-mints it |

The server's rows win with no override logic: the rewind runs before the
upserts. An acked batch's records (pending row gone, echo not yet windowed)
are frozen: short of the head they are pruned by `dropWindowRecords` as today;
the head window rewinds what remains (the ledger's Lemma A carries over:
by then every journal row of that commit has been applied).

`applySnapshot` clears the log and `replay_batches` before its replay.

### Local pages

A replay that mints a page reuses the id the rewind freed for that title
(a per-transaction title-to-id memo), so negative ids do not churn on every
window: backlink pagination groups by `page_id`. `remapLocalPage`
(`reconcile.ts:22-40`) also remaps `replay_log.pre_page_id`, page-kind keys
and `replay_log_refs.target_page_id`.

### Cost

Per window: a handful of set-based rewind statements plus a first apply of
every pending batch, and the recording writes, all O(rows the pending
batches touch). With nothing pending, one emptiness probe, as today. The FK
diff runs per op on replay only when a batch's whole-batch diff finds a
problem (whole batch first, op by op only then).

## What changes for existing guarantees

- **Check R and check 3** of the op divergence property compare exact keys
  everywhere; the sibling-rank mode goes.
- **The cascade exclusion goes.** A head-window tombstone now cascades over
  the server-shaped tree, so a kept block a pending move had placed under the
  deleted block is not taken; replay then skips the move, as the server did.
- **The pkm-jarz transient** (a block a pending local delete cascaded past,
  missing until the head window after the ack) narrows: every window rewinds
  the delete and replays it, so the block reappears as soon as the window
  that re-ships it lands.
- **Poisoned batches'** optimistic effects leave at the next window.
- **Stamps**: a pending row keeps its first apply's `created_at`/`updated_at`.

## Migration

`CLIENT_DDL` changes, so `SCHEMA_VERSION` changes and each replica runs the
schema-change recovery once (flush, snapshot, rebuild), as after pkm-jarz. The
enqueue guard in `workerHandlers.ts:436-444` gains a `replay_log` branch; the
`row_json` `ALTER` branch goes.

## Testing

- **Unit property** (vitest, `replayLog.test.ts`): over drawn replicas and
  batches, enqueue then rewind restores the database exactly: blocks, pages,
  refs, block_refs and FTS rows.
- **Replay equals first apply** (vitest, `apply.test.ts`): each shape in the
  problem table as a fixed test, plus sj5l's.
- Existing suites rewritten where they pin keep semantics or the ledger:
  `placement.test.ts`, `localOps.test.ts`, `effectLedger.test.ts` (becomes
  `replayLog.test.ts`), `apply.test.ts` (keep suites, the ledger suite, the
  jarz suite), `applyFkHazards.test.ts` (per-op skip), `applyLocalPages.test.ts`,
  `reconcile.test.ts`, `workerHandlers.test.ts`. A test whose expected result
  changes says why in its name or a comment.
- The op divergence property's teeth mutant "a replay that always shifts"
  becomes "replay without rewind".
- Gates: `pnpm verify`, `proptest/check.sh web` (sync and ops suites must
  pass clean), `perf/check.sh frontend`.

## Docs

`sync-recovery.md` § The effect ledger becomes § The replay log (the
mechanism, the window order, the frozen case), and its keep rules and
accepted misorderings go; `sync-and-offline.md`'s window step table;
`troubleshooting.md` rows that name the ledger or keep rules are updated, not
deleted; `property-checks.md` loses the cascade exclusion and the rank mode.
