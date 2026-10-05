# Replica replay as a rebase (pkm-j3ui, closes pkm-sj5l) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every feed window rewinds the pending batches' effects from a pre-image log, applies the server's rows, then replays each pending batch as a first apply, so a replayed replica equals a fresh replica with the same batches enqueued.

**Architecture:** A client table `replay_log` (with `replay_log_refs`, `replay_batches`) replaces `effect_ledger`. `localOps.ts` records each row's pre-image before its first write per batch (`replayLog.ts`); `rewind.ts` restores pre-images; `applyWindow` runs drop-acked → prune → rewind → the window → replay → (head) sweep in its one transaction. Keep verdicts, `keepSlot`, `reapply` and the whole of `effectLedger.ts` go.

**Tech Stack:** TypeScript, sqlite-wasm (`replica/testDb.ts` in node), vitest, fast-check.

**Spec:** `docs/superpowers/specs/2026-10-05-replica-replay-rebase-design.md` (read it first; line numbers there are as of `0a4f2845`).

## Global Constraints

- Work in `/Users/arthur/code/llm/pkm/.worktrees/pkm-j3ui` (branch `feat/pkm-j3ui-op-divergence`); the ledger's `common.md` rules apply to every dispatch.
- New runtime files carry `// pattern: Imperative Shell` (both new replica files are shell); tests are exempt.
- No bean ids in code or test comments; comments state the rule, not history.
- Never `REPLACE` (or `INSERT OR REPLACE`) on a `blocks` or `pages` restore: `recursive_triggers=ON` makes its implicit delete fire the FTS delete trigger and the FK cascades.
- Every function in `replayLog.ts` and `rewind.ts` runs inside the caller's transaction and opens none.
- `PRAGMA defer_foreign_keys = ON` stays the first statement of `applyWindow`'s transaction (`applyChanges` relies on it to read an FK failure as COMMIT-time only).
- A test whose expected result changes says why in its name or a one-line comment.
- Commit messages end with `Co-Authored-By: Claude …` only; no `Claude-Session:` trailer, no claude.ai URL.

## Rulings made while planning (bring to Arthur with the plan)

These refine the spec where its text, followed literally, breaks something:

1. **The frozen-record prune moves ahead of the rewind** (spec: after the upserts). At the head window the rewind covers acked batches' records too; if it ran before the prune, a block an acked batch created and the head window ships would be deleted first, and that delete cascades over server rows shipped under it in earlier windows, which no window re-ships. `dropWindowRecords` touches only records of batches no longer in `pending_ops` (a pending batch is always rewound whole), and also drops page records for page ids the window ships.
2. **The stranded-page sweep keeps a page a pending batch's log names** instead of keeping titles a pending op names. Dropping the title exemption alone would sweep a page only a pending `create_page` holds (no block, no ref). So `create_page` records its page even when the page exists (present pre-image), and the sweep keeps any negative page that a `replay_log` page key, a `pre_page_id` or a `replay_log_refs` target names. Finding E stays fixed: the rewind deletes the page the skipped move minted, and the replay never re-mints it.
3. **`replay_batches` survives a snapshot** (spec: cleared). It is pruned to batch ids still in `pending_ops` at every snapshot and window. A pending batch with no row (rows imported by the schema rebuild, or queued before this build) is stamped with the replaying call's `nowMs` and gets its row then, so its stamps stop moving after one replay.
4. **The rewind ends with an orphan drop**: a rewound block whose parent or page is absent once steps 1-4 have run is deleted, deepest first. This happens only when a frozen record outlived the place it names (a page tombstone took it); the alternative is a deferred-FK failure at COMMIT and a needs-bootstrap.
5. **`remapLocalPage` drops a page-kind record with a NULL pre-image** rather than re-keying it: the page is the server's now, and a rewind must never delete a positive id. Rewind step 4 deletes negative ids only, whatever a record says.
6. **`replay_log_refs.log_id` references `replay_log(id) ON DELETE CASCADE`**, so every record delete takes its refs; `PRAGMA foreign_key_check` cannot report it (the parent is never absent while a child exists).
7. The fixed shape tests go in a new `replica/replay.test.ts` rather than `apply.test.ts` (already 2080 lines).

## Review Focus

1. A server row shipped under a block whose create an acked batch logged must survive the head window that ships that block (ruling 1) — pinned in Task 2, `replay.test.ts`.
2. A poisoned batch between two pending batches: its effects leave at the next window, and a later batch's op that depended on them is skipped alone with no COMMIT failure — pinned in Task 2.
3. A pending `create_page` page with nothing on it survives the head window (ruling 2) — pinned in Task 2, `applyLocalPages.test.ts`.
4. A replica whose pending rows have no `replay_batches` row (the post-upgrade rebuild) keeps its stamps from the second window on (ruling 3) — pinned in Task 2.
5. A local page reconciled to the server's id while an acked batch's record still names it: the head rewind restores onto the server id, never the dead negative one — pinned in Task 2, `reconcile.test.ts`.

---

### Task 1: The replay log and the rewind

Model: Opus (product code).

**Files:**
- Modify: `web/src/replica/clientSchema.ts` (add the three tables beside `effect_ledger`; Task 3 removes the ledger)
- Create: `web/src/replica/replayLog.ts`, `web/src/replica/rewind.ts`
- Test: `web/src/replica/replayLog.test.ts`, `web/src/replica/rewind.test.ts`

**Interfaces:**
- DDL (append to `CLIENT_DDL`):
  ```sql
  CREATE TABLE IF NOT EXISTS replay_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('block','page')), key TEXT NOT NULL,
    pre_json TEXT, pre_page_id INTEGER, UNIQUE(batch_id, kind, key));
  CREATE INDEX IF NOT EXISTS idx_replay_log_key ON replay_log(kind, key);
  CREATE TABLE IF NOT EXISTS replay_log_refs(
    log_id INTEGER NOT NULL REFERENCES replay_log(id) ON DELETE CASCADE,
    target_page_id INTEGER NOT NULL, kind TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_replay_log_refs_log ON replay_log_refs(log_id);
  CREATE TABLE IF NOT EXISTS replay_batches(
    batch_id TEXT PRIMARY KEY, enqueued_ms INTEGER NOT NULL);
  ```
- Produces, `replayLog.ts`:
  - `type BlockPreImage = { parent_uid: BlockUid | null; order_idx: OrderIdx; text: string; heading: number | null; collapsed: number; created_at: number | null; updated_at: number | null; view_type: "numbered" | "document" | null }` (every `blocks` column but `uid` and `page_id`); a page pre-image is `{ updated_at: number | null }`.
  - `recordBlocks(db: ReplicaDb, batchId: BatchId, uids: readonly BlockUid[]): void` — `INSERT OR IGNORE` one record per uid: the row's pre-image and `pre_page_id`, or `pre_json` NULL when the uid has no row; then the refs rows of each record this call inserted.
  - `recordSiblingsFrom(db, batchId, group: { pageId: PageId; parentUid: BlockUid | null; fromOrderIdx: OrderIdx }): void` — the same for every row the shift `UPDATE` will move (one statement over the group).
  - `recordPage(db, batchId, pageId: PageId, minted: boolean): void` — `minted` writes `pre_json` NULL.
  - `recordEnqueue(db, batchId, enqueuedMs: number): void` (`INSERT OR IGNORE`); `enqueuedAt(db, batchId): number | null`.
  - `dropWindowRecords(db, { uids, pageIds }: { uids: readonly BlockUid[]; pageIds: readonly PageId[] }): void` — deletes records on those keys whose batch is not in `pending_ops`; one emptiness probe first, as today.
  - `clearReplayLog(db): void` (log and refs); `pruneReplayBatches(db): void` (rows whose batch id is not in `pending_ops`).
  - `remapLogPage(db, { localId, targetId }: { localId: PageId; targetId: PageId }): void` — `pre_page_id` and `replay_log_refs.target_page_id` remapped; page-kind records keyed `localId`: a NULL pre-image is deleted, a present one re-keyed (`UPDATE OR IGNORE`, then delete the leftover: the target's own record wins).
- Produces, `rewind.ts`:
  - `type LogScope = "pending" | "all"` — `pending`: records whose `batch_id` is in `pending_ops` (poisoned included).
  - `type FreedPages = ReadonlyMap<CanonicalTitle, PageId>`
  - `rewind(db: ReplicaDb, scope: LogScope): Map<CanonicalTitle, PageId>` — returns the title and id of each minted page it deleted.

- [ ] **Step 1: Write the failing tests.** Records are made by calling the `record*` functions directly before hand-written SQL writes (Task 2 wires them into `localOps.ts`). `replayLog.test.ts`:
  - `the first touch per batch wins`: record uid `a` for `b1`, update its text, record again: one record, original text.
  - `an absent uid records a NULL pre-image`; `refs rows are recorded with the block` (two refs, one per kind).
  - `recordSiblingsFrom records exactly the rows at or after the slot in that group` (a sibling before the slot and a row in another group get none).
  - `dropWindowRecords leaves a pending batch's records and drops a settled batch's` (insert a `pending_ops` row for `b2` only).
  - `dropWindowRecords drops a settled page record for a shipped page id`.
  - `remapLogPage re-keys pre_page_id, refs targets and a present page record, and deletes a minted one`.
  - `pruneReplayBatches keeps only batches still queued`.
  `rewind.test.ts` (each test dumps `blocks`, `pages`, `refs`, `block_refs` before the batch's writes and compares after `rewind`; also runs `INSERT INTO blocks_fts(blocks_fts, rank) VALUES('integrity-check', 1)` and the same for `pages_fts`, which throw on a stale index):
  - `a present row returns to its pre-image, refs and block_refs included`.
  - `a deleted subtree comes back parents first, under its parent and page`.
  - `a created row is deleted after a moved child is restored elsewhere` (create `x`, move existing `c` under it, rewind: `c` back, `x` gone).
  - `restoring a parent row does not cascade its children` (pins no-REPLACE: children rows and their FTS survive).
  - `the oldest batch's pre-image wins across batches` (`b1` then `b2` both edit `a`).
  - `scope pending leaves a settled batch's records and rows`.
  - `a minted page is deleted and returned by title; a page a block still holds is kept`.
  - `a recorded ref to a page that no longer exists is not restored`.
  - `a rewound block whose parent is gone is dropped` (ruling 4: delete the parent row without a record, then rewind a child's move).
  - `a positive page id is never deleted, whatever its record says`.
- [ ] **Step 2:** `cd web && pnpm exec vitest run src/replica/replayLog.test.ts src/replica/rewind.test.ts` → fail (modules missing).
- [ ] **Step 3: Implement** both files. With no record in scope, `rewind` is one probe and returns an empty map. Its order, per `(kind, key)` taking the in-scope record with the lowest `id`:
  1. blocks present with a pre-image: `UPDATE` every column, `page_id` from `pre_page_id`; replace the row's `refs` from `replay_log_refs` (skipping absent pages); `reindexBlockRefs` where the text changed;
  2. blocks absent with a pre-image: `INSERT` in rounds, each round only rows whose parent (or, top level, page) is present; refs as in 1; `reindexBlockRefs`; a row never placed is dropped;
  3. blocks present with a NULL pre-image: `DELETE`, deepest first;
  4. pages: a NULL pre-image on a negative id with no block and no ref is deleted and returned; a present one restores `updated_at`;
  5. orphan drop over the rewound uids (ruling 4), then delete the in-scope records.
- [ ] **Step 4:** re-run Step 2's command → pass; `pnpm typecheck` → clean.
- [ ] **Step 5: Commit** `feat(replica): a pre-image replay log and its rewind` (clientSchema.ts, the four files).

### Task 2: Windows rewind and replay as a first apply

Model: Opus (product code; the largest task: it switches the mechanism and rewrites the suites that pinned the old one).

**Files:**
- Modify: `web/src/replica/localOps.ts`, `placement.ts`, `queue.ts`, `apply.ts`, `reconcile.ts`, `pageLookup.ts` (header comment only)
- Delete: `web/src/replica/effectLedger.ts`, `effectLedger.test.ts` (their behaviours are Task 1's tests now)
- Create: `web/src/replica/replayArbs.ts` (fast-check arbitraries shared by two tests; add it to `coverage.exclude` in `web/vite.config.ts` beside `src/replica/testDb.ts`), `web/src/replica/replay.test.ts`
- Test (rewrite): `placement.test.ts`, `localOps.test.ts`, `queue.test.ts`, `apply.test.ts`, `applyFkHazards.test.ts`, `applyLocalPages.test.ts`, `reconcile.test.ts`, `rewind.test.ts` (one property added)

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:
  - `placementFor(op: CreateOp | MoveOp, facts: PlacementFacts): Placement` with `Placement = { kind: "skip" } | { kind: "place"; … }` (the `keep` kind and the `reapply` parameter go).
  - `applyLocalOps(db, ops, nowMs, { batchId, freed }: { batchId: BatchId; freed?: FreedPages }): void`.
  - `getOrCreateLocalPage(db, requested, nowMs, record?: { batchId: BatchId; freed?: FreedPages }): PageId` — when it mints and `record` is given: reuse `freed.get(title)` if that id is free, else `MIN(id) - 1`; then `recordPage(…, minted: true)`. Reads that mint daily pages pass no `record`.
  - `enqueueBatch` calls `recordEnqueue(db, batchId, nowMs)` inside its transaction.

- [ ] **Step 1: Write the failing tests.**
  - `replayArbs.ts`: `replicaStateArb` (one or two server pages, ids 1 and 2, up to eight blocks as a forest, texts sometimes holding `[[Title]]` or `((uid))`) and `batchesArb(state)` (one to three batches of one to four ops over existing uids and new ones `newb00`…: create, move with and without `page_title` including a title with no page, `update_text`, `delete`, `set_collapsed`, `set_heading`, `set_view_type`, `create_page`).
  - `rewind.test.ts`: `enqueue then rewind all restores the database exactly` — fast-check, `numRuns: 150`: `applySnapshot` the drawn state, dump, `enqueueBatch` each batch at one `nowMs`, `rewind(db, "all")`, compare the dump (every column) and both FTS integrity checks.
  - `replay.test.ts`, each a differential: the replica after the window equals a fresh replica that `applySnapshot`s the window's resulting server state and `enqueueBatch`es the same batches at the same `nowMs`; dumps compare pages by title and blocks with their page's title in place of `page_id`. A helper builds a head window (`next_since = latest_seq`) that re-ships every page and block of the new server state plus the named tombstones:
    - `order: create X at 0 then move it to 1, over a window that ships another device's Y at 0`;
    - `phantom create: create C under P then move C to the top, over a window that deletes P`;
    - `phantom page: a move of B to the top of a title no page holds, over a window that deletes B` (no page by that title afterwards);
    - `sj5l: move s to 0 then to 1, over two windows that lack the batch` (compared after each);
    - `an empty head window leaves the database exactly as it was` — fast-check over `replicaStateArb`/`batchesArb`, `numRuns: 150`, comparing every column, timestamps and local page ids included;
    - `a server row under a block an acked batch created survives the head window that ships the block` (Review Focus 1: enqueue `b1` creating `x`, delete its `pending_ops` row as the ack does, non-head window ships `y` under `x`, head window ships `x`; `y` is present);
    - `a poisoned middle batch's effects leave at the next window and the later batch's dependent op is skipped alone` (Review Focus 2: `applyChanges` answers `applied`);
    - `a batch with no replay_batches row keeps the stamps of its first replay` (Review Focus 4: delete the row, two windows at different `nowMs`, the second leaves `created_at`/`updated_at` of its rows unchanged).
  - `applyLocalPages.test.ts`: `a pending create_page page with nothing on it survives the head window` (Review Focus 3).
  - `reconcile.test.ts`: `a settled batch's record on a reconciled local page restores onto the server id at the head window` (Review Focus 5).
- [ ] **Step 2:** `cd web && pnpm exec vitest run src/replica/replay.test.ts src/replica/rewind.test.ts` → fail.
- [ ] **Step 3: Implement.**
  - `localOps.ts`: a recorder call before every write: `recordSiblingsFrom` before the shift; `recordBlocks` before the insert (the uid, absent), the move, the re-page and delete-subtree loops (the whole subtree, one call), `update_text` and the `set_*` writes; `recordPage(present)` in `touchPage`; `getOrCreateLocalPage` records its mints (`reindexRefs` passes the batch through); `create_page` records its page whether or not it minted (ruling 2). `keepSlot`, the keep branch and every ledger call go.
  - `placement.ts`: drop `keep`, `reapply` and the two replay branches; update the file header.
  - `apply.ts` `applyWindow`, in its one transaction: defer FKs → compute `owed` as today → `dropAppliedPending` → `pruneReplayBatches` → `dropWindowRecords({ uids: feed.blocks uids + owed, pageIds: feed.pages ids })` → `freed = rewind(db, atHead ? "all" : "pending")` → tombstones, pages, blocks, (head) block tombstones, sidebar, meta, activation reconcile as today → `replayPending(db, nowMs, freed)` → (head) `dropStrandedLocalPages`. `applySnapshot`: `clearReplayLog` and `pruneReplayBatches` in place of `clearLedger`. Rewrite the header and `applyWindow` doc comments to the new order.
  - `replayPending(db, nowMs, freed)` replaces `reapplyPending`: for each non-poisoned batch in queue order, stamp `enqueuedAt(db, batch_id)`, or `nowMs` with `recordEnqueue` when absent; under `SAVEPOINT replay_batch`, apply op by op, each in its own savepoint, a throwing op rolled back alone; then diff `fkViolations`; when the batch adds one, roll back to `replay_batch` and redo it op by op with the diff after each op, rolling back an op that adds one; tighten `before` as today.
  - `reconcile.ts`: `remapLocalPage` calls `remapLogPage`; `dropStrandedLocalPages` keeps a negative page with a block, a ref, a log record naming it (ruling 2) or today's daily title; the pending-title exemption goes.
- [ ] **Step 4: Rewrite the existing suites** until `pnpm test:unit` passes. Tests that read `effect_ledger` either assert the replica state instead, or read `replay_log` (named columns, never `SELECT *`) where the record is the subject; keep-semantics tests whose result changes say why; ledger-internal tests with no behaviour left are deleted (Task 1 covers the mechanism). `applyFkHazards.test.ts` gains `a replayed batch keeps its other ops when one op adds an FK violation`.
- [ ] **Step 5:** `cd web && pnpm test:unit` → pass with coverage thresholds met; `pnpm typecheck` → clean.
- [ ] **Step 6: Commit** `feat(replica): windows rewind pending batches and replay them as a first apply` (all files above).

### Task 3: Retire the effect ledger table

Model: Sonnet (well specified).

**Files:**
- Modify: `web/src/replica/clientSchema.ts` (remove `effect_ledger` and its index), `web/src/replica/workerHandlers.ts:436-444` (enqueue guard)
- Test: `web/src/replica/db.test.ts`, `web/src/replica/workerHandlers.test.ts:1362-1400`

**Interfaces:** `SCHEMA_VERSION` changes as a consequence (one rebuild per device).

- [ ] **Step 1: Rewrite the tests.** `db.test.ts`: `installSchema creates replay_log, replay_log_refs and replay_batches with their indexes` (and no `effect_ledger`). `workerHandlers.test.ts`: replace the two ledger tests with `an enqueue on a file without replay_log creates the tables, records, and leaves schema_version stale` (drop the three tables, enqueue a batch, a `replay_log` row exists, `schema_version` unchanged).
- [ ] **Step 2:** `cd web && pnpm exec vitest run src/replica/db.test.ts src/replica/workerHandlers.test.ts` → the new tests fail.
- [ ] **Step 3: Implement.** The guard becomes `else if (!tableExists(d, "replay_log")) d.exec(CLIENT_DDL);` with its comment updated; the `row_json` `ALTER` branch and `columnExists` (if now unused) go.
- [ ] **Step 4:** `pnpm test:unit` and `pnpm typecheck` → pass.
- [ ] **Step 5: Commit** `feat(replica): the replay log replaces the effect ledger table`.

### Task 4: The op divergence property compares exactly

Model: Opus (oracle work, and the findings that follow).

**Files:**
- Modify: `web/src/props/ops/example.ts`, `compare.ts`, `compare.test.ts`, `ops.prop.ts` (tally print, if it names the removed fields)
- Delete: `web/src/props/ops/cascade.ts`, `cascade.test.ts`

- [ ] **Step 1:** remove the cascade exclusion, `rankOrder`, `touched`/`ranked` and the `effect_ledger` read; checks 3 and R compare exact keys always; the tally's `others` becomes `{ windows, rejected }` and `cascadeExcluded` goes; drop `rankOrder`'s tests. The file header lists the remaining exclusions only (server-minted rows for 1, 3, R; authoritative-reload pages for 1; timestamps).
- [ ] **Step 2:** `cd web && pnpm exec vitest run src/props/ops` (unit tests beside the suite) and `pnpm typecheck` → pass. Commit `test(props): checks 3 and R compare exact keys`.
- [ ] **Step 3: Replay the recorded failures** from the repo root, port 8978 free first: run 8's seed (`--seed 1942743303 --path '66:0:1:2:2:2:2:2:1:3:2:2:2:3:3:3:3:3:3:3:3:3:3'`) and every seed in the ledger's `task-6-report.md`, each `proptest/check.sh web --file ops/ops.prop.ts --seed S --path P`. Each passes or fails on something new.
- [ ] **Step 4: Run the suite unseeded** (`proptest/check.sh web --file ops/ops.prop.ts`) until three consecutive runs pass. Each failure is a finding: classify it (product, wrong property, harness) from the report; a product bug gets its shrunk example as a unit test on its side (vitest beside the code) and a fix, its own commit and a review; a wrong property is fixed in `props/` with the reason in the commit; a model/command disagreement goes to Arthur. Ledger each finding.

### Task 5: Docs

Model: Sonnet, invoking the `architecture-docs` skill.

**Files:** `docs/architecture/sync-recovery.md`, `sync-and-offline.md`, `frontend.md`, `backend.md`, `docs/troubleshooting.md` (each currently names the ledger, `reapplyPending` or keep rules: `grep -nE "effect ledger|effect_ledger|keepSlot|reapplyPending|settleBatches"`).

- [ ] **Step 1:** `sync-recovery.md` § The effect ledger becomes § The replay log: what is recorded and when, the window order as a table (Task 2's), the frozen-record case and why its prune leads the rewind (ruling 1), the sweep's rule (ruling 2); the keep rules and the accepted misorderings go. `sync-and-offline.md`'s window step table follows Task 2's order. `frontend.md` module map: `effectLedger.ts` out, `replayLog.ts` and `rewind.ts` in. `backend.md`: whatever line names the ledger. Troubleshooting rows naming the ledger or keep rules are updated, not deleted, and gain one row for the replay-divergence fix (symptom: a replica's sibling order or a phantom block/page differs from the server's while a batch is pending; owning section § The replay log; pkm-j3ui, pkm-sj5l).
`property-checks.md` has no ops section yet; j3ui Task 8 writes it without the cascade exclusion or the rank mode.
- [ ] **Step 2:** re-run the grep: nothing left outside history-keyed troubleshooting rows. Commit `docs: the replay log replaces the effect ledger` (message says what was corrected and what was added).

## After this plan

Back to the j3ui plan (`2026-10-05-property-checks-op-divergence.md`): Task 7 (teeth; the mutant "a replay that always shifts" becomes "replay without rewind": skip `rewind` in `applyWindow`), Task 8 (calibration, docs), Task 10 (gates: `pnpm verify` with `E2E_PORT=8981`, `proptest/check.sh web` and `server`, `perf/check.sh frontend`, then the Opus whole-branch review). Close pkm-sj5l with this work. Arthur's device rebuilds come due again on deploy (`SCHEMA_VERSION` changed).
