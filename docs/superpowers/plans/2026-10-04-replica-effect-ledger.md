# Replica Effect Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web replica records every collateral sibling shift and descendant re-page a pending batch makes, and reverts the ones the server did not also make once the batch settles, so at rest every replica row equals the server's (pkm-dbr1).

**Architecture:** A client-only table `effect_ledger` keyed by `(batch_id, uid)` holds an order delta and an optional base page per collaterally written block. `localOps.ts` records before each collateral write and drops on each direct write; `applyWindow` drops records for every block a window ships and, at the head window, settles every batch whose pending row is gone. All SQL lives in a new Imperative Shell module, `web/src/replica/effectLedger.ts`.

**Tech Stack:** TypeScript, sqlite-wasm 3.53 (`json_each`, `UPDATE … FROM`), vitest, fast-check (the sync property).

**Spec:** `docs/superpowers/specs/2026-10-04-replica-effect-ledger-design.md` (read it first; its § Correctness is why each rule below is exact). Branch `feat/pkm-dbr1-cross-page`, worktree `.claude/worktrees/pkm-dbr1`.

## Global Constraints

- No protocol change, no server change for the ledger. (The branch already changes `server/` for pkm-xtqz and the harness; leave those alone.)
- DDL exactly as the spec's § Data model: `effect_ledger(batch_id TEXT NOT NULL, uid TEXT NOT NULL, order_delta INTEGER NOT NULL DEFAULT 0, base_page_id INTEGER, base_updated_at INTEGER, PRIMARY KEY (batch_id, uid)) WITHOUT ROWID` plus `CREATE INDEX IF NOT EXISTS idx_effect_ledger_uid ON effect_ledger(uid)`. No foreign keys.
- "Has a page record" means `base_page_id IS NOT NULL`. `base_updated_at` may legitimately be NULL.
- Every file with runtime behaviour carries its `// pattern:` line; `effectLedger.ts` is `// pattern: Imperative Shell`.
- Comments carry no bean ids; a comment states the rule it enforces.
- Run long commands in the foreground with a 600000 ms timeout. Never pipe a gate through a filter; write full output to a file and use `set -o pipefail`.
- Parallel agents on this worktree: split by directory, stage only your own files; port 8978 belongs to one agent at a time (`lsof -iTCP:8978 -sTCP:LISTEN` first).

## Review Focus

1. **A batch replayed over its own echo** (past `PENDING_IDS_CAP`, the window ships the batch's rows but `applied_batches` does not name it): the replay's shifts are recorded and the settle after the ack reverts them; the replica ends equal to the server. → Task 3 test.
2. **One batch moves a subtree root across pages, then moves one of its descendants directly:** the descendant gets no page record (the second op's direct write drops it), and settle leaves the server's row for it. → Task 2 test.
3. **A uid recorded by one batch, deleted by a later batch, then re-created under the same uid** (an undo): the create's direct write drops the stale records; settling the first batch does not touch the recreated row. → Task 2 test.
4. **A base page that is a negative local id when the batch settles, in the same window that delivers the real page:** step 2 remaps the base before step 9 writes it, so the row lands on the server's id. → Task 3 test.
5. **An enqueue whose optimistic apply throws after a shift** (a create onto an existing uid shifts, then the INSERT fails): the `optimistic_op` savepoint rollback removes the recorded shift with it. → Task 2 test.

---

### Task 1: `effect_ledger` table and `effectLedger.ts`

Model: Sonnet (well-specified SQL module).

**Files:**
- Modify: `web/src/replica/clientSchema.ts:13-26` (append the DDL to `CLIENT_DDL`)
- Create: `web/src/replica/effectLedger.ts`
- Create: `web/src/replica/effectLedger.test.ts`
- Modify: `web/src/replica/db.test.ts` (schema tests live here; there is no `clientSchema.test.ts`)

**Interfaces:**
- Produces (all `(db: ReplicaDb, …)`, all run inside the caller's transaction, none opens its own):
  - `recordShift(db, batchId: BatchId, group: { pageId: PageId; parentUid: BlockUid | null; fromOrderIdx: OrderIdx }, exceptUid: BlockUid): void` — call **before** the shift's `UPDATE`; upserts `order_delta + 1` on `(batchId, uid)` for every row with `page_id = pageId AND parent_uid IS parentUid AND order_idx >= fromOrderIdx AND uid != exceptUid`. One `INSERT … SELECT … ON CONFLICT DO UPDATE`.
  - `recordRepage(db, batchId: BatchId, uid: BlockUid): void` — call **before** the re-page `UPDATE` of `uid`. Base = the base any existing record for `uid` carries (any batch), else the row's current `page_id`/`updated_at`. An existing record for `(batchId, uid)` that already has a base keeps it; one without a base (order-only) gains it. No-op when the row is missing.
  - `dropRecordsOf(db, uid: BlockUid): void` — `DELETE … WHERE uid = ?` (direct write).
  - `dropWindowRecords(db, uids: readonly BlockUid[]): void` — returns at once on empty `uids`; else one emptiness probe, and only if the ledger has rows, `DELETE FROM effect_ledger WHERE uid IN (SELECT value FROM json_each(?))`.
  - `settleBatches(db): void` — the spec's § Settling a batch, steps 1–4 (algorithm below).
  - `clearLedger(db): void` — `DELETE FROM effect_ledger`.
  - `remapBasePage(db, { localId, targetId }: { localId: PageId; targetId: PageId }): void` — rewrites `base_page_id`.

Settle algorithm (set-based; "settling" = records whose `batch_id` is not in `SELECT batch_id FROM pending_ops`, poisoned rows included as present):

```sql
-- 2. order
UPDATE blocks SET order_idx = order_idx - d.s
  FROM (SELECT uid, SUM(order_delta) AS s FROM effect_ledger
         WHERE batch_id NOT IN (SELECT batch_id FROM pending_ops)
         GROUP BY uid) AS d
 WHERE blocks.uid = d.uid AND d.s != 0;
-- 3. page: settling page records on a uid with no remaining page record,
--    and only onto a page that exists
UPDATE blocks SET page_id = d.base_page_id, updated_at = d.base_updated_at
  FROM (SELECT uid, base_page_id, base_updated_at FROM effect_ledger e
         WHERE batch_id NOT IN (SELECT batch_id FROM pending_ops)
           AND base_page_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM effect_ledger r
                            WHERE r.uid = e.uid AND r.base_page_id IS NOT NULL
                              AND r.batch_id IN (SELECT batch_id FROM pending_ops))
         GROUP BY uid) AS d
 WHERE blocks.uid = d.uid
   AND EXISTS (SELECT 1 FROM pages WHERE id = d.base_page_id);
-- 4.
DELETE FROM effect_ledger WHERE batch_id NOT IN (SELECT batch_id FROM pending_ops);
```

- [ ] **Step 1: Write the failing tests.** In `db.test.ts`: `installSchema creates effect_ledger and its uid index` (assert both names in `sqlite_master`; `PRAGMA foreign_key_list(effect_ledger)` is empty). In `effectLedger.test.ts` (seed with `openTestDb()`; page 1 `P`, page 2 `S`; P top level `a@0 b@1 c@2`, `c` has child `c1`; insert a `pending_ops` row for each batch id a test treats as pending):
  - `recordShift records +1 per row at or past the slot, never the excepted uid` — shift from 1 except `a`: records `b:+1`, `c:+1`; no record for `a` even when it is in range.
  - `a second shift by the same batch adds to the delta` — `b:+2`.
  - `two batches keep separate deltas`.
  - `recordRepage takes the row's page and updated_at as base when no record has one`.
  - `recordRepage copies another batch's base` — b1 records base P for `c1`; `c1` is moved to S by hand; b2's record carries base P, not S.
  - `a batch's page record keeps its first base` — same batch, second call after the row moved: base unchanged.
  - `recordRepage on an order-only record adds the base and keeps the delta`.
  - `dropRecordsOf deletes every batch's records on the uid, and only those`.
  - `dropWindowRecords deletes records on the listed uids; empty list and empty ledger change nothing`.
  - `settle leaves records whose batch is pending, including a poisoned one`.
  - `settle subtracts the summed delta of every settling batch` — b1 `b:+1`, b2 `b:+1`, only b1 gone: `b` drops by 1 and b2's record stays.
  - `settle writes the base page and updated_at only when the last page record goes` — b1 and b2 both page-record `c1`; b1 settles: `c1` unchanged; b2 settles: `c1` back on P with the base `updated_at`.
  - `settle leaves a row whose base page is gone` — base page deleted: row keeps its page, records deleted.
  - `settle changes nothing for a missing uid` and deletes its records.
  - `remapBasePage rewrites base_page_id from the local id to the target`.
  - `clearLedger empties the table`.

- [ ] **Step 2: Run them to verify they fail.** `cd web && pnpm exec vitest run src/replica/effectLedger.test.ts src/replica/db.test.ts` — FAIL (module and table missing).

- [ ] **Step 3: Add the DDL to `CLIENT_DDL` and implement `effectLedger.ts`** with the interfaces above. File header comment: what the ledger is for and the invariant (spec § Correctness, two bullets), in a few lines.

- [ ] **Step 4: Run to verify they pass.** Same command — PASS. Then `pnpm typecheck`.

- [ ] **Step 5: Commit** `effectLedger.ts`, its test, `clientSchema.ts`, `db.test.ts`: `feat(pkm-dbr1): effect_ledger table and its record, drop and settle statements`.

---

### Task 2: Record and drop in the local apply

Model: Sonnet.

**Files:**
- Modify: `web/src/replica/localOps.ts` (`shiftSiblings` :106-113, `keepSlot` :125-139, `place` :180-225, `applyOne`, `applyLocalOps` :296-304)
- Modify: `web/src/replica/queue.ts:107`, `web/src/replica/apply.ts:178`
- Modify callers in tests: `localOps.test.ts` (31), `apply.test.ts` (2), `blockRefs.test.ts` (2), `missingTarget.test.ts` (1), `reconcile.test.ts` (1)
- Test: `web/src/replica/localOps.test.ts`, `web/src/replica/queue.test.ts`

**Interfaces:**
- Consumes: Task 1's `recordShift`, `recordRepage`, `dropRecordsOf`.
- Produces: `applyLocalOps(db: ReplicaDb, ops: BlockOp[], nowMs: number, opts: { batchId: BatchId; reapply?: boolean }): void` — the options object becomes required. `enqueueBatch` passes its `batchId`; `reapplyPending` passes `b.batch_id`. Test callers pass a fixed `bid("t")`-style id.

Wiring (spec § Where records are written):

| Write in `localOps.ts` | Call |
|---|---|
| `shiftSiblings` (gains an `exceptUid: BlockUid` param, passed `op.uid`) | `recordShift` before its `UPDATE`; the `UPDATE` itself is unchanged |
| `keepSlot`, when it shifts | `recordShift` with `exceptUid = uid` before its `UPDATE` |
| Move re-page loop, create-keep re-page loop | `recordRepage` for every subtree uid except `op.uid`, before that uid's `UPDATE` |
| Create `INSERT`, the move's own `UPDATE`, `op.uid`'s re-page | `dropRecordsOf(op.uid)` after the write |
| `update_text`, `set_*`, `delete`, `create_page`, a skip | Nothing |

`batchId` reaches `place`/`keepSlot`/`shiftSiblings` as a parameter threaded from `applyOne`.

- [ ] **Step 1: Mechanical signature change.** Make `{ batchId }` required, thread it through, update every caller listed above (no behaviour change yet). `pnpm typecheck` and `pnpm exec vitest run src/replica` — PASS, nothing else changed. Commit: `refactor(pkm-dbr1): applyLocalOps takes the batch id it applies for`.

- [ ] **Step 2: Write the failing tests** in `localOps.test.ts`, `describe("applyLocalOps: effect ledger")` (seed of the file: page 1 `uid_r1@0 uid_r2@1`, `uid_r2c` under `uid_r2`; add page 2 rows where needed). A helper `ledger()` returns `SELECT batch_id, uid, order_delta, base_page_id, base_updated_at FROM effect_ledger ORDER BY batch_id, uid`.
  - `a create records +1 on each shifted sibling and nothing for its own uid` — create `uid_new` at top level 0 on page 1: `uid_r1:+1`, `uid_r2:+1`; `uid_r2c` (another group) none.
  - `a move within one group records the shifted siblings, not the moved block`.
  - `a cross-page move records destination siblings and page records for descendants, not the root` — move `uid_r2` to page 2 top: page-2 siblings `+1`; `uid_r2c` record with base page 1 and its prior `updated_at`; no record on `uid_r2`.
  - `a replay that keeps its op in place records nothing` — apply a create, clear nothing, replay with `reapply: true`: ledger unchanged.
  - `a replay whose keepSlot finds a clash adds to the delta` — after the create, put another row on its slot by hand, replay: the clashing row and later ones gain `+1` under the same batch.
  - `a replay of a move no longer in place adds to the delta`.
  - Review Focus 2: `a batch that moves a root across pages then moves its descendant leaves the descendant unrecorded` — `[move uid_r2 → page 2; move uid_r2c → page 2 top]`: no record on `uid_r2c`.
  - Review Focus 3: `re-creating a uid drops the records an earlier batch left on it` — b1 shifts `uid_r1`; b2 deletes `uid_r1`; b3 creates `uid_r1`: no record on `uid_r1`.
  - `update_text, set_collapsed, set_heading, set_view_type, delete and create_page record nothing`.

  In `queue.test.ts`, Review Focus 5: `an op whose optimistic apply throws after its shift leaves no record` — seed a block at the create's slot plus a block whose uid the create reuses, enqueue that create: ledger empty, pending row stored.

- [ ] **Step 3: Run to verify they fail.** `pnpm exec vitest run src/replica/localOps.test.ts src/replica/queue.test.ts` — the new tests FAIL (ledger empty).

- [ ] **Step 4: Wire the calls** per the table.

- [ ] **Step 5: Run to verify they pass**, then the whole `src/replica` directory and `pnpm typecheck` — PASS. An existing test whose expected rows change has found a behaviour the spec changes: report it with the spec section that explains it; do not loosen an assertion to make it pass.

- [ ] **Step 6: Commit** `feat(pkm-dbr1): the local apply records collateral writes and drops records on direct ones`.

---

### Task 3: Window drop, settle, snapshot clear, page paths

Model: Opus (window ordering and the multi-batch cases).

**Files:**
- Modify: `web/src/replica/apply.ts` (`applySnapshot` :113-139, `applyWindow` :474-518, the `applyWindow` doc comment above it)
- Modify: `web/src/replica/reconcile.ts` (`remapLocalPage` :21-31, `dropStrandedLocalPages` :81-96 and its comment)
- Test: `web/src/replica/apply.test.ts`, `web/src/replica/reconcile.test.ts`, `web/src/replica/applyLocalPages.test.ts`

**Interfaces:**
- Consumes: Task 1's `dropWindowRecords`, `settleBatches`, `clearLedger`, `remapBasePage`; Task 2's `applyLocalOps` signature.
- Produces: no new exports; `applyWindow` follows the spec's eleven-step table.

Changes:
- `applyWindow`: right after the block upserts, `dropWindowRecords(db, [...feed.blocks uids, ...every block tombstone uid in feed.tombstones])` (step 4). After `dropAppliedPending` and before `reapplyPending`, `if (atHead) settleBatches(db)` (step 9). Update the doc comment's order sentence.
- `applySnapshot`: `clearLedger(db)` with the table wipe. No settle.
- `remapLocalPage`: `remapBasePage` before the page `DELETE`.
- `dropStrandedLocalPages`: add `AND NOT EXISTS (SELECT 1 FROM effect_ledger WHERE base_page_id = p.id)` to its query (the one ledger predicate kept beside the query it filters), and a clause in its comment.

- [ ] **Step 1: Write the failing tests** in `apply.test.ts`, `describe("applyChanges: the effect ledger")`. Seed via the file's `SNAP` plus rows as each test needs; enqueue with `enqueueBatch`; ack with `ackNext`; a window short of the head has `latest_seq > next_since`.
  - `a window upsert drops records on the shipped block`.
  - `a block tombstone drops records, applied at the head and deferred short of it`.
  - `no revert while the batch is pending`.
  - `no revert in a window short of the head after the ack; revert in the next head window`.
  - `revert at an empty head window after deleteBatch`.
  - `revert in the window whose applied_batches names the batch, before the replay` — a second pending batch's replay builds on the reverted rows (assert its final keys).
  - `a poisoned batch never settles` (`markPoisoned`, head window: records remain).
  - `two pending batches: the spec's table, row by row` — page P `m@0 a@1 r@2`, server has moved `m` to S; b1 untitled top-level move `m`→1, b2 create `X` top of P at 3; assert after each moment: `m1 a2 r3`; `m1 a2 X3 r4`; head window shipping `m` on S + ack of b1 → `a1 X3 r4` with b2 `r:+2`; head window shipping `X@3` after b2's ack → `a1 r2 X3`, ledger empty.
  - `a batch rolled back in reapplyPending leaves only its earlier records` — two variants: a throwing op, and one that adds an FK violation.
  - `applySnapshot clears the ledger and its replay records again`.
  - `a window that rolls back (StaleTitleHolderError) leaves the ledger as it was`.
  - Review Focus 1: `a batch replayed over its own echo reverts at settle` — the window ships the batch's own rows without naming it in `applied_batches`; the replay records; after `ackNext` and a head window the replica equals the shipped server rows.
  - Review Focus 4: `a base on a local page lands on the server's id when the page arrives in the settling window` — the batch re-pages a descendant off a page created locally (negative id); the head window delivers that title's server page and the ack: the descendant ends on the positive id.

  In `reconcile.test.ts`: `remapLocalPage rewrites ledger bases`. In `applyLocalPages.test.ts`: `a local page a ledger base names stays` and `it goes in the window that settles the record`.

- [ ] **Step 2: Run to verify they fail.** `pnpm exec vitest run src/replica/apply.test.ts src/replica/reconcile.test.ts src/replica/applyLocalPages.test.ts` — the new tests FAIL.

- [ ] **Step 3: Implement the changes above.**

- [ ] **Step 4: Run to verify they pass**, then `pnpm exec vitest run src/replica` and `pnpm typecheck` — PASS. Same rule as Task 2 for an existing expectation that changes.

- [ ] **Step 5: Commit** `feat(pkm-dbr1): windows drop ledger records and the head window settles batches`.

---

### Task 4: An old file's first enqueue installs the ledger

Model: Sonnet.

**Files:**
- Modify: `web/src/replica/workerHandlers.ts:429-433` (enqueue handler)
- Test: `web/src/replica/workerHandlers.test.ts`

**Interfaces:**
- Consumes: `CLIENT_DDL` (Task 1), the handler's existing `tableExists`.

- [ ] **Step 1: Write the failing tests.**
  - `an enqueue on a file without effect_ledger creates it, records, and leaves schema_version stale` — open a database, install the schema, `DROP TABLE effect_ledger`, set `schema_version` to `"old"`; enqueue a create that shifts a sibling: table exists, has the record, `schema_version` is still `"old"`.
  - `deleteBatch without a seq, then a head window, reverts` — enqueue a shifting op, `deleteBatch` with no `ackedSeq`, apply a head window that does not ship the shifted sibling: sibling back at its base.

- [ ] **Step 2: Run to verify the first fails** (`pnpm exec vitest run src/replica/workerHandlers.test.ts`). The second may already pass after Task 3; keep it as the handler-level pin.

- [ ] **Step 3:** In the enqueue handler, `else if (!tableExists(d, "effect_ledger")) d.exec(CLIENT_DDL);` after the existing fresh-file branch, with a one-line comment: the stale-schema reset runs from `start()`, and an enqueue before it commits must not fail its first ledger write.

- [ ] **Step 4: Run to verify both pass.**

- [ ] **Step 5: Commit** `fix(pkm-dbr1): an enqueue before the schema reset installs the ledger table`.

---

### Task 5: The dbr1 shapes as unit tests, then the property

Model: Opus (deriving each side's rows needs the server's semantics; read `ops_core.plan_op` and `ops_apply._execute` where unsure).

**Files:**
- Test: `web/src/replica/apply.test.ts`, `describe("applyChanges: a create or move the two sides place in different groups")`
- Run: `web/src/props/sync/sync.prop.ts` (fixed scenarios at :425-560, unchanged)

Each test seeds the replica as stated, enqueues the batch, acks it, applies the head window the server would send (the rows the server wrote, as listed), and asserts the rows the server never re-ships are back at the seed values. The server leaves gaps in a group a block leaves (spec § Several pending batches).

| Test | Seed (replica) | Pending batch | Head window ships | Assert |
|---|---|---|---|---|
| `an untitled top-level move of a block moved to another page elsewhere` | P `m@0 a@1 r@2`; S `x@0` (server already has `m` top of S) | move `m` top level, order 1, no title | `m` on S and S's shifted rows | P `a@1 r@2` |
| `a top-level move to a title renamed away before the pull` | page 1 "Proptest" `s1@0 s2@1 s3@2` (server: page 1 is "Third") | move `s3` top, order 0, `page_title: "Proptest"` | page 1 titled "Third", new page 3 "Proptest", `s3@0` on page 3 | page 1 `s1@0 s2@1` |
| `a top-level create on a title renamed away before the pull` | as above | create `X` top, order 0, `page_title: "Proptest"` | page 1 "Third", page 3 "Proptest", `X@0` on page 3 | page 1 `s1@0 s2@1 s3@2` |
| `an untitled top-level move of a block moved across pages and deleted elsewhere` | P `a@0 m@1 r@2` | move `m` top, order 0, no title | tombstone `m`; S's top level (the server's re-journal) | P `a@0 r@2` |
| `an untitled top-level move after a move to another page, of a block deleted elsewhere` | P `m@0 a@1`; S `x@0 y@1` | `[move m under x; move m top, order 0, no title]` | tombstone `m`; `a@1` on P | S `x@0 y@1` |
| `an untitled top-level move after the batch's own move under a parent deleted elsewhere` | P `a@0 m@1 r@2`; S `x@0 y@1 z@2` | `[move m under y; move m top, order 0, no title]` | tombstone `y`; `m@0`, `a@1`, `r@3` on P | S `x@0 z@2` |
| `a move under a parent another device moved to the block's own page` | P `s1@0`, `s2` child of `s1`, `s2.updated_at = 5`; S `t1@0 t2@1` (server already has `t1` on P) | move `s1` under `t1`, order 0 | `t1` on P, `s1` under `t1` on P | `s2` on P with `updated_at` 5 |

- [ ] **Step 1: Write the seven tests.** Check each against the scenario comment of the same name in `sync.prop.ts` before trusting the table.
- [ ] **Step 2: Run them.** They should pass on Tasks 1–4. One that fails is either a wrong row in this table (fix the test, say why in the commit) or a ledger bug (fix it in the owning task's file with a unit test there).
- [ ] **Step 3: Run the fixed scenarios and the property:** `proptest/check.sh web > $SCRATCH/proptest-web.log 2>&1; echo $?` from the repo root, with port 8978 free. Expected exit 0: the seven dbr1 tests among the fixed scenarios pass and the property finds nothing. A failure: replay it (`--seed/--path/--replay-path`), pin the shrunk shape as a fixed scenario and a unit test, fix, re-run.
- [ ] **Step 4: Re-check `NUM_RUNS`** (`sync.prop.ts:31`, 2300) against the ~3-minute budget using the run's timing; adjust so a run lands near 3 minutes, and give the measured time in the commit.
- [ ] **Step 5: Commit** `test(pkm-dbr1): the cross-page shapes as window sequences; property budget`.

---

### Task 6: Docs for the whole branch

Model: Sonnet. Invoke the `architecture-docs` skill first; verify every claim against the code on this branch.

**Files:** as the spec's § Docs to update table, plus `docs/architecture/property-checks.md`.

- [ ] **Step 1:** `sync-recovery.md`: reverse the "pre-images not worth it" position in § Recovery never erases intent, with a guard row; the sj5l paragraph ends "until the batch settles"; delete the Known gaps table in § Ops on blocks the server no longer has, leaving one sentence on defence in depth; a new ledger subsection under Windows and the pending queue (what is recorded, the drop table, the settle rule with Lemma A in one sentence).
- [ ] **Step 2:** `sync-and-offline.md`: the `applyWindow` step table becomes the eleven steps (including `dropStrandedLocalPages`); `effect_ledger` among the client-only tables. `frontend.md`: `effectLedger.ts` in the module map.
- [ ] **Step 3:** `backend.md`: § Missing targets — destination-sibling journalling is defence in depth for replicas; § The write path — rename takes `BEGIN IMMEDIATE` before its first read (503 + Retry-After when busy).
- [ ] **Step 4:** `property-checks.md`: the second seeded page and title pool, `Rename`, `/__proptest/renames`, rename-aware serial replay, the fixed-scenario count (grep the file for the old count and count the `test(` calls before the property in `sync.prop.ts`), the three new teeth tests, the `NUM_RUNS` from Task 5.
- [ ] **Step 5:** `docs/troubleshooting.md` § Sync and offline: rewrite the pkm-hz8w row's last sentence; new rows for pkm-dbr1, pkm-wj9b, pkm-xtqz; update the pkm-sj5l row (drift now ends at settle).
- [ ] **Step 6:** Run the `check-arch-docs` skill over the diff. Commit `docs(pkm-dbr1): effect ledger, window steps, renames in the property, troubleshooting rows`, saying what was corrected versus added.

---

### Task 7: Gates, review, close

Model: the orchestrator runs the gates; the final review is Opus with mutation probes.

- [ ] **Step 1: Server gates** (the branch changed `server/`): `cd server && uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check` — all clean.
- [ ] **Step 2: Web gate:** `cd web && pnpm verify` (full output to a file, `pipefail`) — exit 0.
- [ ] **Step 3: Property gates:** `proptest/check.sh server`, then `proptest/check.sh web` — both exit 0.
- [ ] **Step 4: Perf**, serial, on a quiet machine: `perf/check.sh frontend`, then `perf/check.sh backend`. Watch `H/cold` `replica_ready_ms` and `W/warm` `first_outline_ms`. Handle results per AGENTS.md; keep the tables for the review package.
- [ ] **Step 5: Final review** (Opus) of `main..HEAD` with mutation probes, at least: drop the step-4 window drop; settle short of the head; settle before `dropAppliedPending`; let `recordShift` record `op.uid`; skip `dropRecordsOf` on the move's own row; let a later batch's `recordRepage` overwrite the base; omit the page-exists check in settle; drop the `remapBasePage` call. Each must turn a unit test or a fixed scenario red.
- [ ] **Step 6: Beans:** check off pkm-dbr1 "Design and fix" and its docs box; check off the docs boxes of pkm-xtqz and pkm-wj9b; add a `## Summary of Changes` to each and mark all three completed; update pkm-sj5l's body (drift now always ends at settle). Commit the bean files.
- [ ] **Step 7:** Hand to Arthur with the perf table and review result; merge `--no-ff` only on his say-so.
