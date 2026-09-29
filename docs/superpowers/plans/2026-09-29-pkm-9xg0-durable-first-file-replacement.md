# Durable-first file replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a rebase replaces a damaged replica file, the pending queue is never held only in worker memory: it is committed to a second OPFS pool database (the carry) before the damaged file is unlinked, and a leftover carry is adopted before any handler serves.

**Architecture:** A new `carryStore.ts` owns the carry database's SQL over an injected file opener (`CarryFiles`), so it is tested against real sqlite-wasm in Node; `worker.ts` implements `CarryFiles` over the SAH pool. `buildHandlers` takes the store as `WorkerDeps.carry`. `rebaseOrReplaceFile` writes the carry before `discardDbFile`, imports from it by id after the schema, and discards it once that import has committed. Every handler reaches the database through one accessor that first adopts a leftover carry.

**Tech Stack:** TypeScript, sqlite-wasm 3.53.0-build1 (`opfs-sahpool` VFS), vitest (node environment for replica tests).

**Spec:** `docs/superpowers/specs/2026-09-29-sync-review-fixes-design.md` § F1 Durable-first file replacement, § Shared rules, § Verification per branch. Source finding: `docs/2026-09-29-sync-subsystem-review-consolidated.md` § F1 and row D2 of § Docs versus code. Bean: pkm-9xg0 (epic pkm-a4t2).

## Global Constraints

- Work in the worktree you were given; paths below are relative to its root. Check `git status -sb` before every commit (worktree agents drift into the main checkout). Use `git diff --no-ext-diff`.
- TDD: every fix's failing test is run and seen red before the fix is written.
- Every runtime file declares `// pattern: Functional Core` or `// pattern: Imperative Shell` (or `Mixed` with a reason) near the top; pure predicates and classifiers go in Functional Core files. `pnpm check:fcis` enforces headers and import edges.
- Code comments (runtime and tests) state the rule and carry no bean id. A comment block this branch edits loses the bean ids it had; untouched comments are left alone (their sweep is pkm-9u3y). Commit messages may carry `pkm-9xg0`.
- The carry file is `/pkm-replica-carry.sqlite3`; its journal is `/pkm-replica-carry.sqlite3-journal`. The replica stays `/pkm-replica.sqlite3`.
- The carried columns are exactly `id, batch_id, ops_json, poisoned, error`, copied verbatim, ids included (the provider deletes the poisoned row by id after the repair; `ackedSeqs` and the pending-id guard key on ids).
- The import into a replica file is `INSERT OR IGNORE INTO pending_ops(id, batch_id, ops_json, poisoned, error) VALUES (?, ?, ?, ?, ?)`, inside one transaction.
- `MIN_POOL_CAPACITY` stays 6.
- The branch carries the doc correction in spec § F1 Docs plus one row in `docs/troubleshooting.md` (symptom, cause, owning section, `pkm-9xg0`). Every edit under `docs/architecture/` is made under the `architecture-docs` skill.
- Web unit coverage thresholds (`web/vite.config.ts`: statements 95, branches 91, functions 89, lines 95) must still pass; `carryStore.ts` is covered, `worker.ts` stays excluded.
- Verification (spec § Verification per branch): `cd web && pnpm verify`, then `perf/check.sh frontend` once the work is complete, before merge.

## Deviations from the spec, decided here

These came from checking the spec against the code. Each is pinned by a test below.

1. **Adoption runs at every handler's entry, not only in `init`.** `enqueue` is documented as able to beat `init` ("the first edit can beat the socket connect that triggers init()", `workerHandlers.ts` enqueue), and `localApi` also enqueues (`localApi/router.ts:103`). Either one on a restarted worker would insert id 1 into the fresh file first, and the carry's row 1 would then be ignored by the by-id import: a lost row. A Retry after a failed replacement in the same worker would likewise rebase an empty queue unless `prepareRecovery` adopts first. So every handler goes through one accessor that adopts; `init` still sees the adopted rows because adoption precedes its schema check.
2. **The carry is discarded straight after the import commits (spec step 3), not after the snapshot (step 5).** If the snapshot then fails, the rows are already durable in the new file, and the worker lives on and drains them. A carry kept past that point would be adopted on the next open and resurrect batches that were acked or deleted since, including the poisoned row. A worker killed between the import commit and the discard leaves a carry whose rows are all still in the file (nothing ran in between), so the by-id import is a no-op.
3. **No carry store, no replacement for a rebase.** `WorkerDeps.carry` is optional like `discardDbFile`; a rebase that meets corruption without one rethrows and keeps the damaged file, rather than replacing without a durable copy.

## Review Focus

- An edit (enqueue or an offline local-API write) served first by a restarted worker while a carry is left over: the carried rows keep ids 1..n and the new batch gets n+1. Test in Task 4.
- A snapshot that fails after the rows were imported, then the queue drains, then the worker restarts: nothing deleted comes back. Test in Task 3.
- The carry write itself fails (a full pool or quota, `SQLITE_FULL`): the damaged file is not touched and still holds the rows. Test in Task 3.
- A carry that exists but cannot be read: the handler fails with that error and the carry is kept, never discarded unread. Test in Task 4.
- Retry after a failed replacement in the same worker (the "repair-failed" banner path): the Retry rebases the carried rows, not an empty queue. Composed test in Task 2, unit test in Task 4.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `web/src/replica/queue.ts` | modify | Gains the `DurablePendingRow` type (moved from `workerHandlers.ts`) and `importPendingRows`, the by-id insert both files use |
| `web/src/replica/carryStore.ts` | create (Imperative Shell) | The carry database: create, replace, read, discard, over injected `CarryFiles` |
| `web/src/replica/carryStore.test.ts` | create | Store against real sqlite-wasm |
| `web/src/replica/testDb.ts` | modify (test helper) | Gains `fakeCarryFiles`, `withDamagedFreelist` (moved from `workerHandlers.test.ts`), `failingOnce` |
| `web/src/replica/workerHandlers.ts` | modify | `WorkerDeps.carry`; durable-first `rebaseOrReplaceFile`; adopt-on-entry accessor |
| `web/src/replica/workerHandlers.test.ts` | modify | Destroying `discardDbFile` fake; failure-injection and adoption tests |
| `web/src/sync/replicaSync.fileReplacement.test.ts` | create | The composed test: poison repair through the real `Replica` facade into real handlers |
| `web/src/replica/poolCapacity.ts` (+ `.test.ts`) | modify | File-name constants and the pool arithmetic |
| `web/src/replica/worker.ts` | modify | `CarryFiles` over the SAH pool; `getFileNames` on `PoolUtil` |
| `docs/architecture/sync-recovery.md`, `sync-and-offline.md`, `frontend.md`, `docs/troubleshooting.md` | modify | Doc correction D2, the carry, the module map, one troubleshooting row |

---

### Task 1: The carry store and the by-id import

**Files:**
- Modify: `web/src/replica/queue.ts` (add after `markPoisoned`)
- Modify: `web/src/replica/workerHandlers.ts:56-62` (delete `DurablePendingRow`, import it from `./queue`)
- Create: `web/src/replica/carryStore.ts`
- Modify: `web/src/replica/testDb.ts`
- Test: `web/src/replica/carryStore.test.ts`, `web/src/replica/queue.test.ts`

**Interfaces:**
- Produces, in `queue.ts`:
  - `export interface DurablePendingRow { id: number; batch_id: string; ops_json: string; poisoned: number; error: string | null }`
  - `export function importPendingRows(db: ReplicaDb, rows: readonly DurablePendingRow[]): void` — the Global Constraints insert, all rows in one `db.transaction`.
- Produces, in `carryStore.ts` (`// pattern: Imperative Shell`):
  - `export interface CarryFiles { exists(): boolean; open(): { db: ReplicaDb; close(): void }; unlink(): void }`
  - `export interface CarryStore { exists(): boolean; write(rows: readonly DurablePendingRow[]): void; read(): DurablePendingRow[]; discard(): void }`
  - `export function createCarryStore(files: CarryFiles): CarryStore`
- Produces, in `testDb.ts` (coverage-excluded helper, no pattern header needed):
  - `export function fakeCarryFiles(t: TestDb): CarryFiles & { closes: number }` — `exists` is false until the first `open()`; `open()` returns `{ db: t.db, close }` without closing `t` (so content persists across opens, as a file would) and counts closes; `unlink()` sets exists false and runs `DROP TABLE IF EXISTS pending_ops` on `t.db`, so a discarded carry is really gone.
  - `export const withDamagedFreelist` — moved unchanged from `workerHandlers.test.ts:452-467`, with its comment's bean id removed.
  - `export function failingOnce(db: ReplicaDb, statement: RegExp, message: string): ReplicaDb` — throws `new Error(message)` from `exec` the first time `sql` matches `statement`, then delegates; `select` and `transaction` delegate (`transaction: (fn) => db.transaction(fn)`, as `withDamagedFreelist` does).

Store behaviour: `write` opens, then in one transaction `CREATE TABLE IF NOT EXISTS pending_ops(id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL, ops_json TEXT NOT NULL, poisoned INTEGER NOT NULL DEFAULT 0, error TEXT)`, `DELETE FROM pending_ops`, `importPendingRows`, and closes in a `finally`. `read` opens, returns `[]` when the table is absent (a carry whose first write never committed), else the five columns `ORDER BY id`, and closes in a `finally`. `discard` is `files.unlink()`. `exists` is `files.exists()`.

- [ ] **Step 1: Write the failing tests**

`queue.test.ts`:
- `"importPendingRows keeps ids verbatim and later enqueues number past them"` — on `openTestDb()`, import rows with ids 4 and 7 (one `poisoned: 1, error: "HTTP 400"`); `SELECT id, batch_id, ops_json, poisoned, error FROM pending_ops ORDER BY id` equals the input; `enqueueBatch(db, [{ op: "delete", uid: "uid_x" }], 10, "after")` then the new row's id is 8.
- `"importPendingRows ignores a row whose id is already present"` — existing row id 1 `batch_id "kept"`; import id 1 `batch_id "other"`; the row still reads `"kept"`.

`carryStore.test.ts` (`// @vitest-environment node`), store over `fakeCarryFiles(await openRawTestDb())`:
- `"a written carry reads back verbatim, ids, poison and error included"` — `exists()` false before, true after; `read()` equals the two written rows.
- `"a second write replaces the first"` — write `[row1, row2]`, then `[row3]`; `read()` equals `[row3]`.
- `"a carry whose table never committed reads as empty"` — `files.open()` alone, then `read()` equals `[]`.
- `"discard removes the carry"` — after `discard()`, `exists()` false and `read()` equals `[]`.
- `"write closes the carry even when the insert fails"` — files whose `open()` returns `failingOnce(t.db, /^INSERT OR IGNORE INTO pending_ops/, "SQLITE_FULL: sqlite3 result code 13: database or disk is full")`; `write` throws `/SQLITE_FULL/`; `closes` is 1; `read()` equals `[]` (the transaction rolled back).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && pnpm vitest run src/replica/queue.test.ts src/replica/carryStore.test.ts`
Expected: FAIL (`importPendingRows` / `./carryStore` not found).

- [ ] **Step 3: Implement `importPendingRows`, `createCarryStore` and the helpers**

Move `withDamagedFreelist` out of `workerHandlers.test.ts` and import it from `./testDb` there.

- [ ] **Step 4: Run them to verify they pass**

Run: `cd web && pnpm vitest run src/replica && pnpm typecheck && pnpm check:fcis`
Expected: PASS, no FCIS diagnostics.

- [ ] **Step 5: Commit**

```bash
git add web/src/replica/queue.ts web/src/replica/queue.test.ts web/src/replica/carryStore.ts web/src/replica/carryStore.test.ts web/src/replica/testDb.ts web/src/replica/workerHandlers.ts web/src/replica/workerHandlers.test.ts
git commit -m "feat(pkm-9xg0): carry store for the pending queue across a file replacement"
```

---

### Task 2: The composed test across the recovery boundary

The spec's one composed test: a poison repair driven by the real `replicaSync` through the real `Replica` facade into real handlers, over a damaged file whose replacement fails once. Before the fix the Retry succeeds over an empty queue, which is the silent loss the finding describes. It is committed as `test.fails` and flipped in Task 4, so every commit stays green.

**Files:**
- Test: `web/src/sync/replicaSync.fileReplacement.test.ts` (`// @vitest-environment node`)

**Interfaces:**
- Consumes: `createCarryStore`, `fakeCarryFiles`, `withDamagedFreelist`, `failingOnce` (Task 1); `WorkerDeps.carry` (added in Task 3; esbuild does not typecheck, so the test runs now and the unknown dep is simply ignored by today's handlers). If `pnpm typecheck` rejects the excess property before Task 3, build the deps object in a variable typed `WorkerDeps & { carry: CarryStore }`.

Harness, modelled on `web/src/replica/client.test.ts:29-37`: `serveRpc(toPortLike(ch.port2), buildHandlers(deps))` and `createReplica(toPortLike(ch.port1))`; `createReplicaSync({ replica, fetchJson, clientId: "c1", onState: () => {} })` with `fetchJson` returning `SNAP` (the same snapshot as `workerHandlers.test.ts:11-18`) for `"/api/sync/snapshot"` and throwing otherwise. Deps: `openDb: async () => current`, where `current` starts as `withDamagedFreelist(damaged.db, /^DELETE /i, () => isDamaged)`; `discardDbFile: () => { damaged.close(); current = failingOnce(fresh.db, /CREATE TABLE/i, "SQLITE_FULL: sqlite3 result code 13: database or disk is full"); }`; `carry: createCarryStore(fakeCarryFiles(carryDb))`; `nowMs: () => 10`.

- [ ] **Step 1: Write the test**

`test.fails("a poison repair whose file replacement fails keeps every queued row for its Retry", ...)`:
- `replica.applySnapshot(SNAP)`; enqueue `[{ op: "move", uid: "uid_gone", parent_uid: "uid_b1", order_idx: 1 }]` as `"rejected"`, then `[{ op: "update_text", uid: "uid_b1", text: "edited" }]` as `"valid"`; `replica.markPoisoned(1, "HTTP 400", "rejected")`; set `isDamaged = true`.
- `await expect(sync.rebaseAuthoritative("poison")).rejects.toThrow(/SQLITE_FULL/)`.
- `await sync.rebaseAuthoritative("poison")` resolves (the banner's Retry).
- `(await replica.pendingBatches()).map(({ id, batch_id, poisoned }) => ({ id, batch_id, poisoned }))` equals `[{ id: 1, batch_id: "rejected", poisoned: true }, { id: 2, batch_id: "valid", poisoned: false }]`.
- `fresh.db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'")` equals `[{ text: "edited" }]`.

- [ ] **Step 2: Confirm the plain `test` form is red for the right reason**

Temporarily write it as `test(...)` and run `cd web && pnpm vitest run src/sync/replicaSync.fileReplacement.test.ts`.
Expected: FAIL at the `pendingBatches` assertion with an empty array (the Retry rebased an empty queue). Any other failure means the harness is wrong: fix it before going on. Then restore `test.fails` and confirm the file passes.

- [ ] **Step 3: Commit**

```bash
git add web/src/sync/replicaSync.fileReplacement.test.ts
git commit -m "test(pkm-9xg0): composed poison repair over a failing file replacement (expected to fail)"
```

---

### Task 3: A rebase writes the carry before it unlinks

**Files:**
- Modify: `web/src/replica/workerHandlers.ts:20-42` (`WorkerDeps`), `:250-260` (`replaceFileAfter`), `:261-285` (`rebaseOrReplaceFile` and its comment)
- Test: `web/src/replica/workerHandlers.test.ts`

**Interfaces:**
- Consumes: `CarryStore`, `importPendingRows`, `DurablePendingRow` (Task 1).
- Produces:
  - `WorkerDeps.carry?: CarryStore`, documented beside `discardDbFile` as "where a rebase commits the queue before a file replacement unlinks the old file".
  - `replaceFileAfter(error: unknown, carriedRows?: readonly DurablePendingRow[]): Promise<ReplicaDb>` — after the existing corruption and `discardDbFile` checks: when `carriedRows` is given and `deps.carry` is absent, rethrow `error`; when given and present, `deps.carry.write(carriedRows)` before `deps.discardDbFile()`. The reset path passes no rows and is unchanged.
  - `rebaseOrReplaceFile` catch: `replaceFileAfter(error, rows)`; `rebuildSchema(fresh)`; `importPendingRows(fresh, deps.carry.read())`; `deps.carry.discard()`; then the snapshot apply.

The rewritten doc comment on `rebaseOrReplaceFile` states the durable boundary and no bean id, in substance: the queue is committed to the carry database before the damaged file and its journal are unlinked; the new file imports the rows from the carry by id after its schema installs, and the carry is discarded once that import commits, so a later snapshot failure leaves the rows in the new file; from the unlink to that commit the carry is the only copy, which is why every handler adopts a leftover carry before it serves. Replace "They commit before the snapshot applies" entirely.

Test fixture changes: in the two existing rebase tests (`:528`, `:573`) the fake becomes `discardDbFile: vi.fn(() => { damaged.close(); current = fresh.db; })` and deps gain `carry` over `fakeCarryFiles`, so the old rows are really gone; drop the bean id from the `:528` test's comment. Both tests keep their assertions. Add `expect(carry.exists()).toBe(false)` to both.

- [ ] **Step 1: Write the failing tests**

Shared setup (a local helper in the test file, e.g. `poisonedQueueOverDamagedFile(freshDb)`): the `:528` test's setup (snapshot, `"rejected"` then `"valid"`, `markPoisoned(1, "HTTP 400", "rejected")`, `rowsBefore` read from `damaged.db`, `isDamaged = true`, `prepareRecovery`), with the destroying fake and a carry, returning `{ handlers, lease, rowsBefore, carry, discardDbFile }`.

- `"a rebase whose new file will not open leaves every row in the carry"` — `openDb` rejects with `new Error("open failed")` on every call after the discard. `commitRecovery` rejects; `carry.read()` equals `rowsBefore`.
- `"a rebase whose schema install fails on the new file leaves every row in the carry"` — fresh is `failingOnce(fresh.db, /CREATE TABLE/i, <SQLITE_FULL message>)`. `commitRecovery` rejects `/SQLITE_FULL/`; `carry.read()` equals `rowsBefore`.
- `"a rebase whose row import fails leaves every row in the carry"` — fresh is `failingOnce(fresh.db, /^INSERT OR IGNORE INTO pending_ops/, <SQLITE_FULL message>)`. Same assertions.
- `"a carry write failure leaves the damaged file and its rows in place"` — carry over files whose `open()` returns `failingOnce(carryDb, /^INSERT OR IGNORE/, <SQLITE_FULL message>)`. `commitRecovery` rejects `/SQLITE_FULL/`; `discardDbFile` not called; `damaged.db` `pending_ops` still equals `rowsBefore`.
- `"a rebase without a carry store keeps the damaged file"` — no `carry` dep. `commitRecovery` rejects `/SQLITE_CORRUPT/`; `discardDbFile` not called; `damaged.db` rows equal `rowsBefore`.
- `"a snapshot failure after the import leaves no carry to resurrect drained rows"` — the `:573` setup plus a second row; after the rejected commit, `carry.exists()` is false; `deleteBatch({ id: 1 })`; then `close()` and `init()` report `pendingBatches` with only id 2. This one passes before the fix (nothing writes a carry yet); it is the guard that fails if the carry is discarded after the snapshot instead of after the import.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && pnpm vitest run src/replica/workerHandlers.test.ts`
Expected: the four "leaves every row in the carry" / carry-write tests FAIL (`carry.read()` is `[]`, or `discardDbFile` was called); "without a carry store" FAILS (`discardDbFile` called); the existing two tests and the snapshot-failure guard pass (nothing writes a carry yet).

- [ ] **Step 3: Implement the `WorkerDeps.carry`, `replaceFileAfter` and `rebaseOrReplaceFile` changes and the comment**

- [ ] **Step 4: Run the replica suite and the typecheck**

Run: `cd web && pnpm vitest run src/replica && pnpm typecheck`
Expected: PASS. The composed test (Task 2) still passes as `test.fails`: the Retry does not adopt yet.

- [ ] **Step 5: Commit**

```bash
git add web/src/replica/workerHandlers.ts web/src/replica/workerHandlers.test.ts
git commit -m "fix(pkm-9xg0): commit the queue to the carry before replacing a damaged replica file"
```

---

### Task 4: Every handler adopts a leftover carry first

**Files:**
- Modify: `web/src/replica/workerHandlers.ts` (a new accessor beside `db()` at `:145-160`; every handler in the returned map)
- Test: `web/src/replica/workerHandlers.test.ts`
- Modify: `web/src/sync/replicaSync.fileReplacement.test.ts` (`test.fails` becomes `test`)

**Interfaces:**
- Consumes: Task 3's `WorkerDeps.carry`; `importPendingRows`.
- Produces (internal to `buildHandlers`):
  - `adoptLeftoverCarry(d: ReplicaDb): void` — returns at once when `deps.carry?.exists()` is not true; otherwise `installSchema(d)` if `sync_client_meta` is absent (the same fresh-file rule `init` and `enqueue` use), `importPendingRows(d, deps.carry.read())`, then `deps.carry.discard()`. A read or import failure propagates and leaves the carry in place.
  - `queueDb(): Promise<ReplicaDb>` — `await db()` then `adoptLeftoverCarry`. Every handler that touches the database (`enqueue`, `nextBatch`, `deleteBatch`, `markPoisoned`, `init`, `applySnapshot`, `applyChanges`, `pendingBatches`, `poisonedBatches`, `pendingCount`, `localApi`, `prepareRecovery`, `commitRecovery`'s re-read, `reset`, `diagnostics`) uses `queueDb()`. `close()` does not. The recovery internals (`rebuildOrReplaceFile`, `replaceFileAfter`, `rebaseOrReplaceFile`) keep calling `db()` directly, since mid-replacement the carry is the rows' only copy and must not be adopted into the half-built file.

A comment on `queueDb` states the rule: a carry that exists holds rows no replica file is known to hold, so it is imported before any handler reads or writes the queue; an insert first would take the carried ids.

- [ ] **Step 1: Write the failing tests**

- `"a worker that dies between discard and import hands its rows to the next worker"` — Task 3's setup, but `openDb` returns `new Promise(() => {})` after the discard. `void handlers.commitRecovery(...)`; `await vi.waitFor(() => expect(discardDbFile).toHaveBeenCalled())`. Build `next = buildHandlers({ openDb: async () => fresh.db, carry, nowMs: () => 10 })` over the same carry files. `next.init()` resolves with `pendingBatches` mapping to `[{ id: 1, batch_id: "rejected", poisoned: true }, { id: 2, batch_id: "valid", poisoned: false }]`; `next.poisonedBatches()` has one entry with `rowId: 1, batchId: "rejected"`; `fresh.db` rows equal `rowsBefore`; `carry.exists()` false.
- `"an enqueue served before init on a restarted worker keeps the carried ids"` — same dead-worker start; `next.enqueue({ ops: [{ op: "delete", uid: "uid_b1" }], batchId: "first-edit" })` before any `init`; `SELECT id, batch_id FROM pending_ops ORDER BY id` on `fresh.db` equals ids 1 `"rejected"`, 2 `"valid"`, 3 `"first-edit"`.
- `"a failed open leaves the carry for the open after close"` — continue Task 3's open-failure test: `openDb` now resolves `fresh.db`; `handlers.close()`; `handlers.init()` reports ids 1 and 2.
- `"a Retry in the same worker rebases the carried rows"` — continue Task 3's import-failure test: `prepareRecovery()` lease `batches` map to ids `[1, 2]`; `commitRecovery({ kind: "rebase", snapshot: SNAP })` resolves; `fresh.db` `pending_ops` equals `rowsBefore`.
- `"a carry that cannot be read is kept and the handler fails"` — a `CarryStore` fake with `exists: () => true`, `read` throwing `new Error("carry unreadable")`, `discard: vi.fn()`; `pendingCount()` rejects `"carry unreadable"`; `discard` not called.

Also flip the composed test to `test(...)`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && pnpm vitest run src/replica/workerHandlers.test.ts src/sync/replicaSync.fileReplacement.test.ts`
Expected: FAIL — `init` returns no pending batches; the enqueue takes id 1; the lease is empty; the composed test's `pendingBatches` is `[]`. The unreadable-carry test fails (`pendingCount` resolves).

- [ ] **Step 3: Implement `adoptLeftoverCarry` and `queueDb` and route the handlers through it**

- [ ] **Step 4: Run the web unit suite**

Run: `cd web && pnpm test:unit && pnpm typecheck`
Expected: PASS, including `client.test.ts` (adoption is a no-op without a carry) and the composed test.

- [ ] **Step 5: Commit**

```bash
git add web/src/replica/workerHandlers.ts web/src/replica/workerHandlers.test.ts web/src/sync/replicaSync.fileReplacement.test.ts
git commit -m "fix(pkm-9xg0): adopt a leftover carry before any handler serves"
```

---

### Task 5: The worker's carry over the SAH pool, and the pool arithmetic

**Files:**
- Modify: `web/src/replica/poolCapacity.ts:31-33` (constants and the `MIN_POOL_CAPACITY` doc comment)
- Test: `web/src/replica/poolCapacity.test.ts`
- Modify: `web/src/replica/worker.ts` (`DB_FILE` at `:16`, `PoolUtil` at `:25-28`, `discardDbFile` at `:70-76`, the `buildHandlers` call at `:78-79`)

**Interfaces:**
- Produces, in `poolCapacity.ts` (stays Functional Core):
  - `export const REPLICA_FILE = "/pkm-replica.sqlite3"`, `export const CARRY_FILE = "/pkm-replica-carry.sqlite3"`
  - `export const journalOf = (file: string): string => \`${file}-journal\``
  - `export const PEAK_POOL_FILES: readonly string[]` — `[REPLICA_FILE, journalOf(REPLICA_FILE), CARRY_FILE, journalOf(CARRY_FILE)]`: what the pool holds at once while the carry is written before the damaged file goes.
- Consumes: `createCarryStore`, `CarryFiles` (Task 1); `WorkerDeps.carry` (Task 3).

Pool arithmetic, checked against sqlite-wasm 3.53.0-build1 (`dist/index.mjs`): every persistent file (main db, main journal) claims a slot whether or not it is open (`getFileNames` lists `#mapFilenameToSAH` keys); the rollback journal exists only during a write transaction; the build has `TEMP_STORE=2`, so temp files stay in memory. Peak is step 1, when the damaged replica (and any hot journal it left) is still in the pool and the carry and its journal are written: four files, within 6. At step 3 the carry is closed with no journal. The `MIN_POOL_CAPACITY` comment says this in place of "the rest cover the rollback journal and temp files".

Worker glue: `PoolUtil` gains `getFileNames(): string[]`. `CarryFiles` over the pool: `exists` is `pool?.getFileNames().includes(CARRY_FILE) ?? false` (sqlite-wasm normalises names to a URL pathname, so the leading slash is kept and matches); `open` wraps `new pool.OpfsSAHPoolDb(CARRY_FILE)` with `wrapSqlite` and closes the raw db; `unlink` removes `journalOf(CARRY_FILE)` then `CARRY_FILE`, the journal first for the reason `discardDbFile` gives. `discardDbFile` uses `REPLICA_FILE` and `journalOf`. Pass `carry: createCarryStore(carryFiles)` to `buildHandlers`. The openDb comment block is not edited beyond the constant name.

- [ ] **Step 1: Write the failing test**

`poolCapacity.test.ts`: `it("holds the replica, the carry and both journals at once")` — `PEAK_POOL_FILES` equals `["/pkm-replica.sqlite3", "/pkm-replica.sqlite3-journal", "/pkm-replica-carry.sqlite3", "/pkm-replica-carry.sqlite3-journal"]`, and `MIN_POOL_CAPACITY` is at least `new Set(PEAK_POOL_FILES).size`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && pnpm vitest run src/replica/poolCapacity.test.ts`
Expected: FAIL (`PEAK_POOL_FILES` undefined).

- [ ] **Step 3: Add the constants and comment, then wire `worker.ts`**

- [ ] **Step 4: Verify types, FCIS and the build**

Run: `cd web && pnpm vitest run src/replica/poolCapacity.test.ts && pnpm typecheck && pnpm check:fcis && pnpm build`
Expected: PASS; the build succeeds (the worker bundle compiles against the real `PoolUtil` surface).

- [ ] **Step 5: Commit**

```bash
git add web/src/replica/poolCapacity.ts web/src/replica/poolCapacity.test.ts web/src/replica/worker.ts
git commit -m "feat(pkm-9xg0): worker carry over the SAH pool; pool arithmetic covers replica, carry and journals"
```

---

### Task 6: Docs

Invoke the `architecture-docs` skill before editing anything under `docs/architecture/`. Verify every claim against the code as shipped in Tasks 1 to 5, not against this plan.

**Files:**
- Modify: `docs/architecture/sync-recovery.md` — § Failure modes at a glance (table at `:15-35`), § Recovery never erases intent (`:203`), § Reset, rebase and file replacement (`:326-351`), and the pool note at `:128-132`
- Modify: `docs/architecture/sync-and-offline.md` § The replica (`:303`, "One file, `/pkm-replica.sqlite3`")
- Modify: `docs/architecture/frontend.md` module map (`:138-151`)
- Modify: `docs/troubleshooting.md` sync table (after the pkm-1b2w row at `:119`)

- [ ] **Step 1: `sync-recovery.md`**
  - § Reset, rebase and file replacement: the paragraph beginning "A `rebase` meets the same damage" says rows "commit before the snapshot applies". Replace it with the carry sequence as a short numbered table (step, action, which file holds the rows if the worker dies there), matching Task 3 and deviation 2: carry written, damaged file and journal unlinked, fresh file schema and by-id import, carry discarded, snapshot applied. One sentence on adoption at every handler's entry and why (an edit can reach a restarted worker before `init`).
  - § Recovery never erases intent: one guard row — "A rebase that replaces the file commits the queue to a carry database first; every handler adopts a leftover carry before serving" | `workerHandlers.ts`, `carryStore.ts` | "A failed open, schema install or import, or a killed worker, losing the queue during a file replacement". This makes the heading the failure table's rows at `:24-25` cite true again (review D2); those rows need no edit.
  - § Failure modes at a glance: the "A rebuild or rebase meets page-level file damage" row's "Must hold" becomes "A rebase commits the queue to the carry before unlinking".
  - Pool note (`:128-132`): six slots cover the replica, the carry and their journals at once (`PEAK_POOL_FILES`).
- [ ] **Step 2: `sync-and-offline.md` § The replica** — the "One file" sentence also names `/pkm-replica-carry.sqlite3`, present only while a file replacement is in flight or a worker died during one, linking § Reset, rebase and file replacement.
- [ ] **Step 3: `frontend.md` module map** — add `carryStore.ts  Shell  The pending queue's durable copy across a file replacement` under `replica/`.
- [ ] **Step 4: `docs/troubleshooting.md`** — one row in the sync table: Symptom "After a 'Local repair failed' banner on a damaged replica, queued offline edits are gone and Retry reports success" | Cause "File replacement unlinked the damaged file before the new one held the queue, so a failed open, schema install or import, or a suspended worker, lost the rows. The queue is now committed to a carry database first and adopted on the next handler" | `[sync-recovery.md § Reset, rebase and file replacement](architecture/sync-recovery.md#reset-rebase-and-file-replacement)` | `pkm-9xg0`. (The doc's preamble limits rows to failures that happened; this one was found by review. The row is required by the epic's shared rules; keep the symptom phrased as what a user would see.)
- [ ] **Step 5: Stale enumerations** — `grep -n "One file\|two files\|MIN_POOL_CAPACITY\|carries the durable queue" docs/architecture/*.md` and fix any count or claim the change made stale.
- [ ] **Step 6: Commit**

```bash
git add docs/architecture/sync-recovery.md docs/architecture/sync-and-offline.md docs/architecture/frontend.md docs/troubleshooting.md
git commit -m "docs(pkm-9xg0): carry step in file replacement; recovery never erases intent holds again

Corrected: the rebase's file replacement no longer claims rows commit before the snapshot.
Added: the carry sequence, adopt-on-entry, pool arithmetic, module map entry, troubleshooting row."
```

---

### Task 7: Verification, perf, bean

- [ ] **Step 1: Full web verification**

Run: `cd web && pnpm verify`
Expected: typecheck, lint, `check:fcis`, coverage thresholds and Playwright all pass. A known load-sensitive e2e flake is re-run once in isolation before being treated as real.

- [ ] **Step 2: Perf**

Run: `perf/check.sh frontend`
Expected: no regression. On a **regression**, read this diff along the regressed path (the per-handler `carry.exists()` call is the one new cost), fix and re-run; bring it to Arthur with the table only if it survives. **Unstable**: file a bean against the perf harness and carry on without touching it. **Stale baseline**: `perf/check.sh frontend --rebaseline`. **Lost** or **reclassified**: `--bootstrap`. Commit any baseline file it rewrites. Keep the table for the review package.

- [ ] **Step 3: Bean**

Tick each todo in `.beans/` for pkm-9xg0 with `beans update pkm-9xg0 --body-replace-old "- [ ] <item>" --body-replace-new "- [x] <item>"` (the "verify, perf, merge" item is ticked for verify and perf; merge is the orchestrator's). Append `## Summary of Changes` (the carry store, durable-first rebase, adopt-on-entry, the three deviations above and why, docs touched, the perf result) with `--body-append`. Then `beans update pkm-9xg0 -s completed` only if no unchecked item remains; otherwise leave it in-progress and say why in the report.

- [ ] **Step 4: Commit**

```bash
git status -sb
git add .beans/ perf/
git commit -m "chore(pkm-9xg0): bean summary, checklist and perf result"
```
