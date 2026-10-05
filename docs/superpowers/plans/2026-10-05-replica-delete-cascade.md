# Replica Delete Cascade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A block the server kept is back on the replica after a local delete cascaded past it.

**Architecture:** A local delete records each cascaded descendant's base row as a row record in `effect_ledger` (new `row_json` column). The existing drop rules clear the records of blocks the server also deleted. `settleBatches` restores the row records still standing, parents first, after its reverts.

**Tech Stack:** TypeScript, sqlite-wasm (replica), vitest, fast-check sync harness.

**Spec:** `docs/superpowers/specs/2026-10-05-replica-delete-cascade-design.md`

## Global Constraints

- Worktree `/Users/arthur/code/llm/pkm/.worktrees/pkm-jarz`, branch `fix/pkm-jarz-delete-cascade`. Run every command from there. Run `pnpm install` in `web/` and `uv sync` in `server/` once before Task 1.
- No wire change and no server change.
- Each new `.ts` file with runtime behaviour starts with a `// pattern: ...` line. `pageLookup.ts` is `// pattern: Imperative Shell` (it reads the db).
- Code and test comments carry no bean ids.
- The `row_json` keys are exactly `parent_uid`, `order_idx`, `text`, `heading`, `collapsed`, `created_at`, `updated_at`, `view_type`. `refs` is never stored.
- The delete's root (`op.uid`) never gets a row record. Only its descendants do.
- The restore never mints a page and never throws on a missing ref target. It runs inside a window transaction.
- Long commands run in the foreground with a 600000 ms timeout. Never pipe a gate through a filter. Write to a file and use `set -o pipefail` if you must pipe.

## Review Focus

1. **A restored row's ref names a page created offline, reconciled since.** The ref lands on the server's page id. Task 2's test "restore derives refs against pages present, minting none" covers this.
2. **The restored row's parent was re-paged by a batch settling in the same window.** The row lands on the parent's page after the revert. Task 2's test "a restored row takes its parent's page after the page revert".
3. **Two batches settle at once, and one batch's restore is another's parent.** Rounds restore both. Task 2's test "rounds restore a child whose parent another settling batch restores".
4. **A still-pending later delete covers a restored row.** The step-10 replay cascades it again and records it again. Task 2's window test "a pending delete replayed after the restore records the restored rows again".
5. **A delete enqueued on an old-schema file.** The guard adds `row_json`, the optimistic apply stands, and `schema_version` stays stale. Task 1's workerHandlers test.

---

### Task 1: Record cascaded rows

**Files:**
- Modify: `web/src/replica/clientSchema.ts:27-34` (add `row_json TEXT` to `effect_ledger`)
- Modify: `web/src/replica/effectLedger.ts` (add `recordCascade`; header comment gains the row record)
- Modify: `web/src/replica/localOps.ts:264-270` (delete case)
- Modify: `web/src/replica/workerHandlers.ts:434-436` (enqueue guard)
- Test: `web/src/replica/effectLedger.test.ts`, `web/src/replica/localOps.test.ts`, `web/src/replica/workerHandlers.test.ts`

**Interfaces:**
- Produces: `recordCascade(db: ReplicaDb, batchId: BatchId, uid: BlockUid): void` in `effectLedger.ts`. Call it before the row's `DELETE`. Produces `export type CascadedRow = { parent_uid: BlockUid | null; order_idx: OrderIdx; text: string; heading: number | null; collapsed: number; created_at: number | null; updated_at: number | null; view_type: "numbered" | "document" | null }`, the parsed `row_json`.
- The record: `(batch_id, uid, order_delta 0, base_page_id = base page, base_updated_at NULL, row_json)`.

- [ ] **Step 1: Make existing ledger reads name their columns**

  `effectLedger.test.ts`'s `ledger()` runs `SELECT *`. Every `toEqual` on it would now also see `row_json: null`, so change it to select `batch_id, uid, order_delta, base_page_id, base_updated_at`. Grep `web/src/replica/*.test.ts` for `SELECT * FROM effect_ledger` (and `SELECT *` reads of it under other spellings) and do the same.

- [ ] **Step 2: Write the failing tests**

  In `effectLedger.test.ts` (fixture: page 1, top-level `a b c`, `c1` under `c` with `updated_at` 111), add `const rowRec = (uid: string) => t.db.select<{batch_id: string; base_page_id: number | null; base_updated_at: number | null; order_delta: number; row_json: string | null}>("SELECT batch_id, base_page_id, base_updated_at, order_delta, row_json FROM effect_ledger WHERE uid = ?", [uid])`.

  ```ts
  describe("recordCascade", () => {
    test("stores the base row with pending shifts taken out and absorbs every other record", () => {
      recordShift(t.db, b1, { pageId: P, parentUid: u("c"), fromOrderIdx: idx(0) }, u("x"));
      t.db.exec("UPDATE blocks SET order_idx = 1 WHERE uid = 'c1'");
      recordCascade(t.db, b2, u("c1"));
      const recs = rowRec("c1");
      expect(recs.map(({ row_json, ...r }) => r)).toEqual([
        { batch_id: "b2", base_page_id: 1, base_updated_at: null, order_delta: 0 }]);
      expect(JSON.parse(recs[0].row_json!)).toEqual({
        parent_uid: "c", order_idx: 0, text: "c1", heading: null, collapsed: 0,
        created_at: null, updated_at: 111, view_type: null });
    });

    test("takes the page and updated_at an earlier page record carries", () => {
      recordRepage(t.db, b1, u("c1"));
      t.db.exec("UPDATE blocks SET page_id = 2, updated_at = 222 WHERE uid = 'c1'");
      recordCascade(t.db, b2, u("c1"));
      const [rec] = rowRec("c1");
      expect(rec.base_page_id).toBe(1);
      expect(JSON.parse(rec.row_json!).updated_at).toBe(111);
    });
  });
  ```

  In `localOps.test.ts`, under `describe("applyLocalOps: effect ledger")` (fixture: `uid_r2 > uid_r2c`), first add the grandchild `uid_r2cc` under `uid_r2c`:

  ```ts
  test("a delete records each cascaded descendant and never the root", () => {
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('uid_r2cc', 1, 'uid_r2c', 0, 'grandchild')");
    apply(t.db, [{ op: "delete", uid: uid("uid_r2") }], 99, b("b1"));
    expect(rows<{ uid: string; has: number }>(
      "SELECT uid, row_json IS NOT NULL AS has FROM effect_ledger ORDER BY uid"))
      .toEqual([{ uid: "uid_r2c", has: 1 }, { uid: "uid_r2cc", has: 1 }]);
  });
  ```

  In `workerHandlers.test.ts`, beside "an enqueue on a file without effect_ledger …", add a test using `TWO` plus a child row. Build the snapshot as `{ ...TWO, blocks: [...TWO.blocks, { ...TWO.blocks[0], uid: uid("uid_c"), parent_uid: uid("uid_b2"), order_idx: ord(0), text: "c" }] }`. Then:
  - after `applySnapshot`, `DROP TABLE effect_ledger`;
  - re-create it with the old DDL (the current `CREATE TABLE` without `row_json`);
  - set `schema_version` to `'old'`;
  - enqueue `[{ op: "delete", uid: uid("uid_b2") }]` as batch `a`.

  Expect:
  - `SELECT uid FROM effect_ledger WHERE row_json IS NOT NULL` equals `[{ uid: "uid_c" }]`;
  - `uid_b2` and `uid_c` are gone from `blocks`;
  - `schema_version` is still `'old'`.

  Name it "an enqueue on a file whose effect_ledger lacks row_json adds the column, records the cascade, and leaves schema_version stale".

- [ ] **Step 3: Run them to verify they fail**

  Run: `cd web && pnpm exec vitest run src/replica/effectLedger.test.ts src/replica/localOps.test.ts src/replica/workerHandlers.test.ts`

  Expected: the new tests FAIL: `recordCascade` is not exported, and there is no `row_json` column.

- [ ] **Step 4: Implement**

  - **`clientSchema.ts`:** add `row_json TEXT` after `base_updated_at`.
  - **`effectLedger.ts` `recordCascade`:**
    - Read the block row.
    - Read the uid's records: `SUM(order_delta)`, plus `base_page_id` and `base_updated_at` from any record with `base_page_id IS NOT NULL AND row_json IS NULL`.
    - Compute the base, per spec § Data model.
    - `DELETE FROM effect_ledger WHERE uid = ?`.
    - Insert the row record.

    Extend the header comment: a row record means the block was removed by that batch's cascade. Its `row_json` is the base row, and it absorbs every other record on the uid.
  - **`localOps.ts` delete case:** `if (uid !== op.uid) recordCascade(db, batchId, uid);` before each `DELETE`. `applyOne` already has `batchId`.
  - **`workerHandlers.ts` enqueue guard:** when `effect_ledger` is missing, run `CLIENT_DDL` as now. Otherwise, when `pragma_table_info('effect_ledger')` has no `row_json`, run `ALTER TABLE effect_ledger ADD COLUMN row_json TEXT`. Update the comment.

- [ ] **Step 5: Run the replica tests**

  Run: `cd web && pnpm exec vitest run src/replica`

  Expected: PASS, including the existing "delete removes every row from a 150-block subtree".

- [ ] **Step 6: Commit**

  ```bash
  git add web/src/replica/{clientSchema,effectLedger,localOps,workerHandlers}.ts web/src/replica/*.test.ts
  git commit -m "feat(replica): a local delete records the rows its cascade removes"
  ```

### Task 2: Restore standing row records at settle

**Files:**
- Create: `web/src/replica/pageLookup.ts`: `storedPageTitle`, `localPageTitle`, `pageIdByTitle`, `existingLocalPageId`, moved from `localOps.ts:51-74`
- Modify: `web/src/replica/localOps.ts` (import them from `pageLookup.ts`)
- Modify: `web/src/replica/effectLedger.ts` (`settleBatches`)
- Test: `web/src/replica/effectLedger.test.ts`, `web/src/replica/apply.test.ts`

**Interfaces:**
- Consumes: `recordCascade` and `CascadedRow` from Task 1.
- Produces: `existingLocalPageId(db: ReplicaDb, title: string): PageId | null` exported from `pageLookup.ts`. The other three moved functions are exported only if `localOps.ts` still needs them. `settleBatches(db: ReplicaDb): void` keeps its signature.

- [ ] **Step 1: Write the failing unit tests in `effectLedger.test.ts`**

  Use `recordCascade` and then `DELETE FROM blocks` to stage row records. Leave the batch out of `pending_ops` so it settles.

  ```ts
  describe("settleBatches: row records", () => {
    const cascade = (batch: BatchId, ...uids: string[]) => {
      for (const id of uids) recordCascade(t.db, batch, u(id));
      for (const id of [...uids].reverse()) t.db.exec("DELETE FROM blocks WHERE uid = ?", [id]);
    };
    // stage c > c1 > c2 so there are two levels to restore
    beforeEach(() => {
      t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, updated_at)" +
                " VALUES ('c2', 1, 'c1', 0, 'see [[S]] and ((a))', 5)");
    });
  ```

  Tests:
  - **"restores a standing row record, parents first, with refs, block refs and FTS":**
    - Run `cascade(b1, "c2", "c1")`, then `settleBatches`.
    - The `c1` and `c2` rows equal their pre-cascade rows (`parent_uid`, `order_idx`, `text`, `updated_at`, `page_id`).
    - `refs` holds `{src_block_uid: 'c2', target_page_id: 2, kind: 'link'}`.
    - `block_refs` holds `('c2','a')`.
    - The `blocks_fts MATCH 'see'` join returns `c2`.
    - The ledger is empty.
  - **"restore derives refs against pages present, minting none":**
    - Rename page 2's title to something else before the settle, so `[[S]]` names no page.
    - After settle, `c2` is restored with no `refs` rows.
    - `SELECT COUNT(*) FROM pages` is unchanged.
  - **"a record whose parent is absent is dropped, not restored":**
    - Run `cascade(b1, "c2")`, then `DELETE FROM blocks WHERE uid = 'c1'`, then settle.
    - `c2` is absent and the ledger is empty.
  - **"a pending batch's row record waits":** `pend("b1")`, `cascade(b1, "c2")`, then settle. `c2` is still absent and the record is still there.
  - **"a restored row takes its parent's page after the page revert":**
    - Give `c1` a b1 page record (`recordRepage(t.db, b1, u("c1"))`).
    - Then run `UPDATE blocks SET page_id = 2 WHERE uid IN ('c1','c2')`, with no page record for `c2`, so `c2`'s base page is 2.
    - Run `cascade(b1, "c2")`, then settle.
    - `c1` is back on page 1, and `c2` is restored on page 1 (its parent's page), not page 2 (its base).
  - **"rounds restore a child whose parent another settling batch restores":** `cascade(b1, "c2")`, then `cascade(b2, "c1")`, then settle. Both are restored. The child's record sorts first, so a single pass would miss it.

- [ ] **Step 2: Write the failing window tests in `apply.test.ts`**

  Add a new `describe("applyChanges: a local delete's cascade past a block the server kept")`. Its own `beforeEach` seeds `applySnapshot` with:
  - pages `page(1, "P")` and `page(2, "S")`;
  - blocks `block("p", 1)`, `block("k", 1, { parent_uid: uid("p") })` and `block("g", 1, { parent_uid: uid("k") })`;
  - `seq: 10`.

  Tests:
  - **"a child moved out elsewhere keeps its unchanged grandchild":**
    - `enqueueBatch(t.db, [{ op: "delete", uid: uid("p") }], 2, bid("b1"))`, then `ackNext`.
    - Apply `emptyFeed({ next_since: 11, latest_seq: 11, blocks: [block("k", 1, { order_idx: ord(1) })], tombstones: [{ kind: "block", entity_id: "p" }] })`.
    - `k` (top level) and `g` (under `k`) exist, `p` does not, and the ledger is empty.
  - **"the server's cascade tombstones drop the records and nothing is restored":** the same, but the window ships tombstones for `p`, `k` and `g`. `blocks` holds none of them and the ledger is empty.
  - **"the records wait while the delete is pending, across a window that is not the head":**
    - Enqueue without acking.
    - Apply a non-head window (`next_since: 11, latest_seq: 12`) shipping `k` at the top level.
    - `g` is still absent and its record stands.
    - Then `ackNext` and apply the head window (`next_since: 12, latest_seq: 12`, tombstone `p`). `g` is restored under `k`.
  - **"a pending delete replayed after the restore records the restored rows again":**
    - Batch b1 deletes `p`, and batch b2 deletes `k`. Ack b1 only.
    - The head window ships `k` (top level) and `p`'s tombstone.
    - Afterwards `g` is absent, because b2's replay cascaded it, and its row record belongs to `b2`.

- [ ] **Step 3: Run them to verify they fail**

  Run: `cd web && pnpm exec vitest run src/replica/effectLedger.test.ts src/replica/apply.test.ts`

  Expected: the new restore tests FAIL (rows absent). "the server's cascade tombstones …" may already pass.

- [ ] **Step 4: Move the title lookup into `pageLookup.ts`**

  Move the four functions verbatim. `localOps.ts` imports what it uses. Then run `cd web && pnpm exec vitest run src/replica/localOps.test.ts`. Expected: PASS.

- [ ] **Step 5: Implement the restore in `settleBatches`**

  - Restrict the page revert's inner select to `row_json IS NULL`, and its `NOT EXISTS` probe too.
  - After the two reverts and before the final `DELETE`, restore the settling row records in rounds:

    ```
    remaining = settling records with row_json (uid, base_page_id, parsed row)
    loop:
      inserted = 0
      for rec in remaining, skipping uids present in blocks:
        page = rec.parent_uid === null
          ? (page rec.base_page_id exists ? rec.base_page_id : none)
          : (page_id of the parent row, if present)
        if page is none: continue
        INSERT the block row (uid, page, row fields)
        { refs } = reindexBlockRefs(db, uid, text)
        for each ref: id = existingLocalPageId(db, ref.title); if id !== null INSERT OR IGNORE INTO refs
        remove rec from remaining; inserted += 1
      until inserted === 0
    ```
  - The final `DELETE` drops the leftovers.
  - Update the `settleBatches` doc comment: it reverts, then restores each standing row record whose parent is present, parents first.

- [ ] **Step 6: Run the replica tests**

  Run: `cd web && pnpm exec vitest run src/replica`. Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add web/src/replica/{pageLookup,localOps,effectLedger}.ts web/src/replica/{effectLedger,apply}.test.ts
  git commit -m "fix(replica): settling a delete restores the descendants the server kept"
  ```

### Task 3: Pin the scenarios and run the gates

**Files:**
- Modify: `web/src/props/sync/sync.prop.ts` (fixed scenarios, after the "move under a parent another device moved to the block's own page" test, ~line 544)

**Interfaces:**
- Consumes: the harness's `runExample`, `Edit`, `Drained`, `Pull`, `Offline` and `draft`. Add any of these that the file does not already import.

- [ ] **Step 1: Add the three scenarios**

  Copy S1, "S1 control" and "S1 variant" from the bean (`beans show pkm-jarz`) verbatim, with their comments, but drop the "S1:" prefixes from the test names. The names become:
  - "offline delete of a parent whose child another device moved out"
  - "offline delete of a parent whose child another device moved out, own echo not yet pulled"
  - "offline delete of a parent whose child another device moved out, nesting made by the other device"

  Put a pool guard first in each: `expect(EDIT_TARGETS[0]).toBe("pt_seed_1")`, `expect(EDIT_TARGETS[5]).toBe("pt_sec_1")` and `expect(EDIT_TARGETS[7]).toBe("pt_sec_3")`, as a `const assertSecondPool` beside `assertPool`.

- [ ] **Step 2: Run the sync suite**

  First check `lsof -iTCP:8978 -sTCP:LISTEN` is empty.

  Run: `set -o pipefail; proptest/check.sh web --file sync/sync.prop.ts > <scratch>/sync.log 2>&1; echo exit=$?`, where `<scratch>` is your scratchpad directory

  Expected: `exit=0`, with the three new scenarios and the property passing. A property failure is a finding. Report it with its replay line; do not weaken anything.

- [ ] **Step 3: Run the web gates**

  Run: `cd web && E2E_PORT=8981 pnpm verify > <scratch>/verify.log 2>&1; echo exit=$?`. Expected: `exit=0`.

  Run: `proptest/check.sh web > <scratch>/proptest-web.log 2>&1; echo exit=$?`. Expected: `exit=0` (sync and outline suites, plus teeth).

  Run: `perf/check.sh frontend > <scratch>/perf.log 2>&1; echo exit=$?`. Expected: no regression. Follow AGENTS.md on any outcome other than "no change" or "improved".

- [ ] **Step 4: Commit**

  ```bash
  git add web/src/props/sync/sync.prop.ts
  git commit -m "test(props): pin the offline delete past a moved-out child"
  ```

  Also commit any baseline file perf rewrote.

### Task 4: Docs and bean

**Files:**
- Modify: `docs/architecture/sync-recovery.md` § The effect ledger (~291-330), and the effect-ledger row of "Recovery never erases intent" (~342)
- Modify: `docs/architecture/sync-and-offline.md` step-9 row (~156)
- Modify: `docs/troubleshooting.md` (one row after the pkm-d3qh row)
- Modify: `.beans/pkm-jarz--*.md`

- [ ] **Step 1: Invoke the `architecture-docs` skill**, then make the edits:
  - **Ledger write table:** a row for "A descendant a delete cascades": a row record holding the base row, which absorbs the uid's other records.
  - **Opening paragraph:** names cascaded deletes among the collateral writes.
  - **Settle paragraph:** after the reverts, standing row records are restored parents first, under the parent's page, with refs derived from text against pages present; a record whose parent is absent is dropped.
  - **Table description:** gains `row_json`.
  - **Old file before its reset:** the enqueue guard also adds the column.
  - **Step-9 row in `sync-and-offline.md`:** "Reverts … and restores rows a settled delete cascaded past".
  - **`troubleshooting.md` row:**
    - Symptom: a replica lacks a block another device moved out from under a parent this replica deleted offline; the server has it.
    - Cause: the local delete cascaded it, and its row never changed again.
    - Owning section: sync-recovery.md § The effect ledger.
    - Bean: pkm-jarz.

  Grep the docs for enumerations this changes (e.g. "two reverts", the ledger's record kinds) and fix the counts.

- [ ] **Step 2: Bean.** Check off the work in the pkm-jarz body, append `## Summary of Changes`, and set `-s completed`.

- [ ] **Step 3: Commit**

  ```bash
  git add docs/architecture/sync-recovery.md docs/architecture/sync-and-offline.md docs/troubleshooting.md .beans/
  git commit -m "docs(pkm-jarz): the ledger's row records and the settle restore"
  ```
