# Pending-rebase perf scenario Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `perf/check.sh frontend` gains scenario letter R, which counts the SQLite work `applyChanges` does when it applies three feed windows over a pending queue.

**Architecture:** A Node vitest scenario (`web/tooling/perf/rebase.perf.ts`, own config) builds in-memory sqlite-wasm replicas through the worker's `buildHandlers`, gets a snapshot and three real windows from the fixture server, and counts statements / trigger statements / VM steps / full scans inside `applyChanges` with `sqlite3_trace_v2` and the progress handler. `check.mjs` runs it as a subprocess for letter R; `run.py` passes `PERF_WEB_ROOT` so a merge-base run imports the base's replica source.

**Tech Stack:** vitest (node environment), `@sqlite.org/sqlite-wasm` `capi`, Playwright-free Node `fetch`, Python `perfcheck`.

**Spec:** `docs/superpowers/specs/2026-10-06-perf-pending-rebase-design.md`

## Global Constraints

- Worktree: `/Users/arthur/code/llm/pkm/.claude/worktrees/pkm-p5t6` (branch `feat/pkm-p5t6-perf-pending-rebase`). Never touch `/Users/arthur/code/llm/pkm` directly.
- No change under `web/src/`. The scenario only imports from it.
- Every metric is `exact`. Scenario names: `R/rebase-edit`, `R/rebase-paste`, `R/rebase-overlap`. Metric names: `statements`, `trigger_statements`, `vm_steps_k`, `full_scans`.
- `PROGRESS_N = 1000` (the backend's value, `server/tooling/perfcheck/trace.py`).
- `$SCRATCH` below means `/private/tmp/claude-501/-Users-arthur-code-llm-pkm/e730c02c-03c1-4ba5-a9e0-1e0802b4a6c4/scratchpad`.
- Fixture server port 8977 belongs to `perf/check.sh`; for manual runs use port 8979 (unassigned) and stop the server by PID.
- Code comments carry no bean ids. Each new TS file starts `// pattern: Functional Core` or `// pattern: Imperative Shell`.
- Second client id `perf-rebase-peer`; window batch ids `perf-rebase-w1`, `perf-rebase-w2`, `perf-rebase-w3`; pending batch ids `perf-rebase-p1` … `perf-rebase-p6` (OpBatch needs `batch_id` length 8–64). Block uids match `[a-zA-Z0-9_-]{6,32}`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; no session URLs. Stage files by explicit path. `git status -sb` before each commit.

## Review Focus

1. **A merge-base run imports the branch's replica code instead of the base's.** Expected: with `PERF_WEB_ROOT` pointing at another checkout, every `src/replica` module and `@sqlite.org/sqlite-wasm` resolve under that checkout. Task 2 step 6 pins it by running against a cached merge-base worktree and printing the resolved paths.
2. **The pending queue is silently not pending.** If `enqueue` throws or the batches are rejected locally, windows apply over an empty queue and the counts measure nothing. Expected: the scenario asserts `pendingBatches()` returns six non-poisoned batches before each window. Task 2.
3. **`applyChanges` answers `pending-changed` or `needs-bootstrap`.** Expected: the scenario fails loudly unless each window's result is `{status: "applied"}`. Task 2.
4. **Counts include work outside `applyChanges`** (the `pendingBatches` read, snapshot apply). Expected: counters are reset immediately before and read immediately after the `applyChanges` call. Task 1's `measure` API makes this the only way to count.
5. **The two passes agree only by accident** (e.g. both count zero because the trace hook was never installed). Expected: the scenario fails if any window's `statements` is 0; Task 1's test proves the hook counts a known number of statements.

---

### Task 1: SQL counter and plan classifier

**Files:**
- Create: `web/tooling/perf/sqlcount.ts`
- Test: `web/tooling/perf/sqlcount.test.ts` (first line `// @vitest-environment node`; it runs under `pnpm test:unit`)

**Interfaces:**
- Produces:
  - `export const PROGRESS_N = 1000;`
  - `export interface SqlCounts { statements: number; trigger_statements: number; vm_steps_k: number; full_scans: number }`
  - `export function plannable(sql: string): boolean` — port of `sqlplan.plannable`.
  - `export function aliases(sql: string): Map<string, string>` — port of `sqlplan.aliases` (same `_NOT_ALIAS` word list and regex).
  - `export function fullScans(details: readonly string[], tables: ReadonlySet<string>, names?: ReadonlyMap<string, string>): string[]` — port of `sqlplan.full_scans`.
  - `export function installCounter(sqlite3: Sqlite3Like, raw: { pointer: number } & Oo1Exec): Counter` where `Counter` is `{ measure<T>(fn: () => T | Promise<T>): Promise<{ result: T; counts: SqlCounts }>; uninstall(): void }` (async, because the worker handlers are; nothing else touches the DB while it awaits). `Sqlite3Like` is the minimal `capi` surface used: `sqlite3_trace_v2`, `sqlite3_progress_handler`, `SQLITE_TRACE_STMT`, and `wasm.cstrToJs` (or whatever the installed version's binding needs to read the SQL argument). `Oo1Exec` is the oo1 `selectArrays`/`exec` surface needed for `EXPLAIN QUERY PLAN`.
  - `measure` resets counters, runs `fn`, then computes `full_scans` by running `EXPLAIN QUERY PLAN <sql>` for each distinct top-level plannable statement traced during `fn` (with tracing paused), counting rows `fullScans` returns against the real tables (`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`, minus virtual tables, i.e. rows whose `sql` starts `CREATE VIRTUAL TABLE`). A statement `EXPLAIN QUERY PLAN` cannot plan throws (does not count zero). `vm_steps_k` is the progress-callback tick count (one per `PROGRESS_N` instructions). A trace line starting `--` counts as `trigger_statements`, anything else as `statements`.

- [ ] **Step 1: Write the failing tests**

Port the cases from `server/tests/test_perfcheck_sqlplan.py` for `plannable`, `aliases`, `fullScans` (same inputs, same expected outputs). Add:

```ts
test("measure counts top-level and trigger statements inside fn only", async () => {
  const { sqlite3, raw } = await memoryDb();   // helper: sqlite3InitModule() + new sqlite3.oo1.DB(":memory:")
  raw.exec("CREATE TABLE t(a); CREATE TABLE log(a);" +
           "CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN INSERT INTO log VALUES (new.a); END;");
  raw.exec("INSERT INTO t VALUES (0)");        // outside measure: not counted
  const c = installCounter(sqlite3, raw);
  const { counts } = await c.measure(() => {
    raw.exec("INSERT INTO t VALUES (1)");
    raw.exec("INSERT INTO t VALUES (2)");
  });
  expect(counts.statements).toBe(2);
  expect(counts.trigger_statements).toBe(2);
  c.uninstall();
});

test("measure ticks the progress handler on heavy work", async () => {
  // a recursive CTE counting to 200_000 runs far more than PROGRESS_N instructions
  expect(counts.vm_steps_k).toBeGreaterThan(10);
});

test("full_scans counts an unindexed read of a real table, not an indexed one", async () => {
  // CREATE TABLE t(a, b); CREATE INDEX t_a ON t(a);
  // measure SELECT * FROM t WHERE b = 1  -> full_scans 1
  // measure SELECT * FROM t WHERE a = 1  -> full_scans 0
});

test("a traced statement EXPLAIN QUERY PLAN cannot plan throws", ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && pnpm exec vitest run tooling/perf/sqlcount.test.ts`
Expected: FAIL (module not found / exports missing — then make sure at least the measure tests fail on assertions, not only on imports, once stubs exist).

- [ ] **Step 3: Implement `sqlcount.ts`** (Functional Core for the ports, the counter is Imperative Shell; one file is fine with `// pattern: Mixed (unavoidable)` and the reason "the counter is a thin hook around the pure classifiers", or split the classifiers into `sqlplan.ts` if lint/fcis prefers — pick one and say which in the commit).

Find in `node_modules/@sqlite.org/sqlite-wasm/dist/` how `sqlite3_trace_v2` takes a JS callback (it has a `::callback` adapter) and what its `x` argument is for `SQLITE_TRACE_STMT` (a C string pointer to the expanded or unexpanded SQL; trigger sub-statements arrive with a leading `--`). Same for `sqlite3_progress_handler`. The callback must return 0.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm exec vitest run tooling/perf/sqlcount.test.ts && pnpm lint && pnpm check:fcis`
Expected: PASS, no lint or fcis errors.

- [ ] **Step 5: Commit** `web/tooling/perf/sqlcount.ts`, `web/tooling/perf/sqlcount.test.ts`: `test(pkm-p5t6): SQL statement, VM-step and full-scan counter for the replica perf scenario`.

---

### Task 2: The rebase scenario

**Files:**
- Create: `web/tooling/perf/rebaseTargets.ts` (Functional Core: target selection and op builders)
- Test: `web/tooling/perf/rebaseTargets.test.ts` (`// @vitest-environment node`)
- Create: `web/tooling/perf/rebase.perf.ts` (Imperative Shell: the scenario)
- Create: `web/tooling/perf/vitest.rebase.config.ts`

**Interfaces:**
- Consumes: Task 1's `installCounter`, `SqlCounts`, `PROGRESS_N`.
- Consumes from `$PERF_WEB_ROOT/src` (dynamic `import()` of absolute paths, never a static import): `replica/workerHandlers.ts` `buildHandlers`, `replica/db.ts` `wrapSqlite`; types only may come from the branch's `src` statically. `@sqlite.org/sqlite-wasm` resolved from `$PERF_WEB_ROOT` (`createRequire(path.join(root, "package.json")).resolve(...)`, then `import(pathToFileURL(...))`).
- Produces (environment contract with Task 3): reads `PERF_WEB_ROOT` (absolute path to a `web/` dir), `PERF_BASE_URL` (e.g. `http://127.0.0.1:8977`), `PERF_REBASE_OUT` (JSON output path); writes
  `{ "R/rebase-edit": {statements:{class:"exact",value:N}, trigger_statements:{…}, vm_steps_k:{…}, full_scans:{…}}, "R/rebase-paste": {…}, "R/rebase-overlap": {…} }`
  via temp file + rename. Exits non-zero (a failed vitest test) on any error.
- Produces from `rebaseTargets.ts`:
  - `export interface Targets { deleteRoot: BlockUid; editUids: BlockUid[] /* 8 */; moveUids: BlockUid[] /* 3 */; moveParent: BlockUid; createParent: BlockUid; windowEditUid: BlockUid; pasteParent: BlockUid; overlapMoveUid: BlockUid }`
  - `export function pickTargets(snapshot: Snapshot, pageTitle: string): Targets`
  - `export function pendingBatches(t: Targets, snapshot: Snapshot): { batchId: BatchId; ops: BlockOp[] }[]` — six batches, below.
  - `export function windowBatches(t: Targets, snapshot: Snapshot): { batchId: BatchId; ops: BlockOp[] }[]` — three batches, below.

**Target selection** (`pickTargets`, deterministic from the snapshot, page `"Perf Big Page"`):
- `deleteRoot`: the page block whose subtree size (itself plus descendants) is closest to 21; ties to the smallest uid. Throw if no block has a subtree of at least 5.
- Every other target comes from the page's blocks outside `deleteRoot`'s subtree, sorted by uid, taken in this order without reuse: `editUids` (8), `moveUids` (3), `moveParent`, `createParent`, `windowEditUid`, `pasteParent`, `overlapMoveUid`. None of `moveUids` may be an ancestor of `moveParent` or `createParent` (skip candidates that are). Throw if the page runs out.

**Pending queue** (`pendingBatches`, ids `perf-rebase-p1`…`p6`; no base hashes — `enqueue` adds what the wire needs):
1. `p1`: 10 `create` ops under `createParent`, uids `perfrebc01`…`perfrebc10`, `order_idx` = createParent's current child count + i, text `perf rebase create i`.
2. `p2`: `update_text` on `editUids[0..3]`, text = old text + ` (pending edit)`.
3. `p3`: `move` `moveUids[0..2]` under `moveParent`, appended after its current children.
4. `p4`: `update_text` on `editUids[4..7]`, same suffix.
5. `p5`: `delete` `deleteRoot`.
6. `p6`: `update_text` on `perfrebc01`, text `perf rebase create 1, edited`.

**Windows** (`windowBatches`, client `perf-rebase-peer`, ids `perf-rebase-w1`…`w3`):
1. edit: `update_text` `windowEditUid`, old text + ` (peer edit)`.
2. paste: 50 `create` ops under `pasteParent`, uids `perfrebp01`…`perfrebp50`, appended.
3. overlap: `update_text` `editUids[0]` (pending `p2` also edits it), old text + ` (peer overlap)`; and `move` `overlapMoveUid` under `createParent` (pending `p1` adds children there), appended.

**Scenario flow** (`rebase.perf.ts`, one vitest `test` with a long timeout):
1. `POST /api/login` with `{password: "e2e-pw"}`; keep the cookie (as `src/props/sync/serverControl.ts` `login()` does).
2. `GET /api/sync/snapshot`.
3. For each window batch: `POST /api/ops` with `{client_id, batch_id, ops}`, assert 2xx; then `GET /api/sync/changes?since=<cursor>` (cursor starts at the snapshot's `seq`, then each window's `next_since`). Keep the three payloads.
4. Twice: open a fresh `:memory:` DB (`new sqlite3.oo1.DB(":memory:")`, `PRAGMA foreign_keys=ON`, `PRAGMA recursive_triggers=ON` as `worker.ts` `pragmas` does), `installCounter`, `buildHandlers({ openDb: async () => wrapSqlite(raw), nowMs: () => FROZEN_MS, newBatchId: () => { throw … } })` (every enqueue passes its own `batchId`), then `init(undefined)`, `applySnapshot(snapshot)`, `enqueue({ops, batchId})` for each pending batch, and for each window: `const pending = await h.pendingBatches()`; assert 6 non-poisoned; `await counter.measure(() => h.applyChanges({feed, expectedPendingIds: pending.map(b => b.id)}))`; assert `status === "applied"`; assert `statements > 0`.
   `FROZEN_MS` = `Date.parse(process.env.PERF_FROZEN_NOW ?? "2026-06-15T12:00:00+01:00")` (`fixture.FROZEN_NOW`; `check.mjs` passes `PERF_FROZEN_NOW` through).
5. Fail unless both passes give identical counts per window (message names the window and both values). Write the output JSON.

`vitest.rebase.config.ts`: like `vitest.props.config.ts` (stand-alone, `environment: "node"`, `setupFiles: []`, `pool: "forks"`, single fork, `testTimeout: 600_000`), `include: ["tooling/perf/rebase.perf.ts"]`, and `server.fs.allow` / `server.fs.strict: false` if vite refuses to load files under an outside `PERF_WEB_ROOT`.

- [ ] **Step 1: Write failing `rebaseTargets.test.ts`**: a hand-built snapshot (one page, ~40 blocks with one subtree of exactly 21 and one of 6) asserting: `deleteRoot` is the 21-subtree root; no target lies in its subtree; targets are distinct; `pendingBatches` has 6 batches with the ids above and `p5` is a single `delete` of `deleteRoot`; `windowBatches[2]` edits `editUids[0]` and moves `overlapMoveUid` under `createParent`; `pickTargets` throws on a page with no subtree ≥ 5.
- [ ] **Step 2: Run it, expect FAIL.** `cd web && pnpm exec vitest run tooling/perf/rebaseTargets.test.ts`
- [ ] **Step 3: Implement `rebaseTargets.ts`.** Check `src/api/types.d.ts` for the exact `CreateOp`/`MoveOp`/`UpdateTextOp`/`DeleteOp` and `SnapshotPayload` field names (snapshot blocks carry `uid`, `page_id`, `parent_uid`, `order_idx`, `text`; pages carry `id`, `title`).
- [ ] **Step 4: Run it, expect PASS.**
- [ ] **Step 5: Implement `rebase.perf.ts` and `vitest.rebase.config.ts`.** Then run against a manually started fixture server:
  ```bash
  cd /Users/arthur/code/llm/pkm/.claude/worktrees/pkm-p5t6/server
  FIX=$(PYTHONPATH=tooling uv run python -c "from perfcheck.build import cached_fixture; print(cached_fixture())")
  E2E_PORT=8979 E2E_FROM_DB=$FIX E2E_FROZEN_NOW=2026-06-15T12:00:00+01:00 E2E_INSTANCE=manual \
    E2E_WEB_DIST=$PWD/../web/dist E2E_SERVER_LOG=$SCRATCH/server-errors.log PYTHONPATH=tooling \
    uv run --with time-machine python tests/e2e_serve.py &   # note its PID; kill it by PID afterwards
  ```
  Then
  `cd ../web && PERF_WEB_ROOT=$PWD PERF_BASE_URL=http://127.0.0.1:8979 PERF_REBASE_OUT=$SCRATCH/rebase.json pnpm exec vitest run --config tooling/perf/vitest.rebase.config.ts`
  Expected: PASS; `$SCRATCH/rebase.json` has three scenarios with non-zero counts. Run it twice more with a fresh server each time: the counts must be identical across runs (restart the server between runs — the window batches can only be posted once per server).
- [ ] **Step 6: Merge-base import check (Review Focus 1).** Temporarily log the resolved module URLs; run with `PERF_WEB_ROOT` set to a cached merge-base worktree's `web/` (`ls ~/.cache/pkm-perf/worktrees/*/web/node_modules` for one that has node_modules); confirm every `src/replica` and sqlite-wasm URL is under that path. Remove the logging. Note the result in the report.
- [ ] **Step 7: `cd web && pnpm lint && pnpm check:fcis && pnpm test:unit`** — PASS.
- [ ] **Step 8: Commit** the four files: `feat(pkm-p5t6): perf scenario applying feed windows over a pending queue`.

---

### Task 3: Wire letter R into the gate

**Files:**
- Modify: `web/tooling/perf/check.mjs` (`LETTERS`, a `rebase()` runner, `main()`)
- Modify: `server/tooling/perfcheck/run_core.py` (`_CONTEXT_GROUPS = ("HW", "ABFI", "JKS", "R")`)
- Modify: `server/tooling/perfcheck/run.py` (`FrontendRunner.run`: add `"PERF_WEB_ROOT": str(worktree / "web")` to the `check.mjs` env)
- Test: `server/tests/test_perfcheck_run.py`

**Interfaces:**
- Consumes: Task 2's environment contract and output JSON.

- [ ] **Step 1: Failing tests** in `test_perfcheck_run.py`: `run_core.frontend_letters(["R/rebase-edit"]) == "R"`; `run_core.frontend_letters(["R/rebase-paste", "F/typing"]) == "A,B,F,I,R"`; and a `FrontendRunner` test (follow the file's existing pattern for `server_command`/subprocess mocking) asserting the `check.mjs` env carries `PERF_WEB_ROOT == str(worktree / "web")`. If `run()` is not testable without a refactor, extract the check.mjs command/env into a `check_command(worktree, only, commit, out)` method mirroring `server_command`, and test that.
- [ ] **Step 2: Run, expect FAIL.** `cd server && uv run pytest -q tests/test_perfcheck_run.py`
- [ ] **Step 3: Implement** the `run_core.py` and `run.py` changes.
- [ ] **Step 4: `check.mjs`:** `LETTERS = "H,W,A,B,F,J,I,K,S,R"`. `async function rebase()` spawns `pnpm exec vitest run --config tooling/perf/vitest.rebase.config.ts` (cwd = this `web/` dir, i.e. `HERE/../..`; env adds `PERF_BASE_URL = BASE`, `PERF_REBASE_OUT = <OUT>.rebase.json`, passes through `PERF_WEB_ROOT` defaulting to this `web/` dir), throws with the subprocess's tail output on non-zero exit, and merges the JSON into `scenarios`. In `main()`, after the browser groups: `if (ONLY.has("R")) await run("R/rebase", () => rebase());`. Keep the scenario's stdout out of `check.mjs`'s stdout unless it fails.
- [ ] **Step 5: Run** `cd server && uv run pytest -q tests/test_perfcheck_run.py && uv run ruff check && uv run pyrefly check` — PASS.
- [ ] **Step 6: Run the gate side once:** `perf/check.sh frontend` (foreground, long timeout, nothing else running). Expected: existing scenarios pass; the three R scenarios report `new`; exit 0. Do **not** commit the rewritten `perf/baseline-frontend.json` — the orchestrator bootstraps it in Task 4. `git checkout perf/baseline-frontend.json` if it changed.
- [ ] **Step 7: Commit** `check.mjs`, `run_core.py`, `run.py`, `test_perfcheck_run.py`: `feat(pkm-p5t6): run the rebase scenario as frontend letter R`.

---

### Task 4: Mutation check, baseline, docs (orchestrator)

**Files:**
- Modify: `perf/baseline-frontend.json` (by `--bootstrap`)
- Modify: `docs/architecture/performance-checks.md`, `web/tooling/perf/README.md`
- Modify: `.beans/pkm-p5t6--*.md`

- [ ] **Step 1: Mutation check.** Temporarily add `raw.exec("DROP INDEX idx_replay_log_key")` after `applySnapshot` in pass setup; run the scenario (Task 2 step 5 command); `vm_steps_k` or `full_scans` must rise for at least one window. Revert. Record before/after numbers in the bean.
- [ ] **Step 2: Bootstrap** on a quiet machine (no other suites, no other perf runs): `perf/check.sh frontend --bootstrap`. Expected: exit 0, five runs agree on every R metric. Commit `perf/baseline-frontend.json` with a message saying it records the new R scenarios.
- [ ] **Step 3: Docs** (invoke the `architecture-docs` skill): in `performance-checks.md` add R to the frontend scenario table and the context-group table (R: no browser context, a Node subprocess), add `$PERF_WEB_ROOT/src` and the sqlite-wasm module to the "comes from the merge base" column, extend the determinism table (fixed `nowMs` and batch ids; windows fetched from the scenario's own snapshot cursor; two-pass agreement), and the "Extending the gate" frontend row (a Node scenario also needs its config's `include`). Grep the doc for counts or letter lists that now miss R (`H,W,A,B,F,J,I,K,S`, "three groups"). README: list `sqlcount.ts`, `rebaseTargets.ts`, `rebase.perf.ts`, `vitest.rebase.config.ts`.
- [ ] **Step 4: Bean** summary with the mutation numbers and the bootstrap table; mark completed. Commit docs + bean.
