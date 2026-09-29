# SAH pool hot-journal rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a replica worker is killed partway through a write, the next open of that file rolls the transaction back instead of leaving the file torn.

**Architecture:** A version-pinned pnpm patch to `@sqlite.org/sqlite-wasm`'s opfs-sahpool VFS makes `xCheckReservedLock` report a RESERVED lock only when a file this pool has open on the same path holds one. SQLite's `hasHotJournal` then recognises a killed worker's journal as hot and plays it back on the next read. A Playwright spec proves this in real Chromium, against the shipped worker bundle, using a test-only "tool" worker on the same OPFS pool.

**Tech Stack:** sqlite-wasm 3.53.0-build1 (opfs-sahpool VFS), pnpm 12 `patchedDependencies`, Playwright (Chromium), TypeScript.

**Spec:** No spec section. The inputs are bean `pkm-87cf` (`beans show pkm-87cf`) and finding I-2 / Chromium scenario G of the pkm-9xg0 adversarial review (its text is summarised under Investigation below; the scratch file is not in the repo).

---

## Investigation

### 1. The VFS, SQLite's hot-journal rule, and upstream

**Installed:** `@sqlite.org/sqlite-wasm` **3.53.0-build1**, pinned exactly in `web/package.json:20`. **Newest on npm:** **3.53.4-build1** (2026-09-08). **Upstream trunk:** `ext/wasm/api/sqlite3-vfs-opfs-sahpool.c-pp.js`, checked 2026-09-29, including that day's check-in "OPFS SAHPool: more cleanly handle an init failure" (`preserveOnInitFailure`). All three have the same code:

```js
xCheckReservedLock: function(pFile, pOut) {
  const pool = getPoolForPFile(pFile);
  pool.log("xCheckReservedLock");
  pool.storeErr();
  wasm.poke32(pOut, 1);      // web/node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs:14588-14594
  return 0;
},
```

The rest of the pool's locking (`index.mjs`):
- `xLock` (:14622) and `xUnlock` (:14673) only store `file.lockType` on the per-open file object. They never refuse a lock, so every lock SQLite asks for is granted.
- `xOpen` (:14756) gives each `sqlite3_file` its own `{path, flags, sah, lockType}` object in the pool's private `#mapS3FileToOFile_` (`getOFileForS3File` at :15117). A journal is the pool path `<db>-journal`. `xOpen` reuses an existing path's SAH, and takes a new slot only for a new path with `SQLITE_OPEN_CREATE`. `PERSISTENT_FILE_TYPES` includes `MAIN_JOURNAL`, so a journal survives in the pool across workers.
- `xAccess` (:14703) reports whether the path is in the pool. `xDelete` frees the slot.
- `acquireAccessHandles` (:14838) opens a `createSyncAccessHandle()` on **every** file in the pool directory, and releases all of them if any one fails. Default-mode SAHs are exclusive. **No two workers (or tabs) can hold the same pool file.**

SQLite's `hasHotJournal` (`src/pager.c`) runs at the start of every read transaction: when a `-journal` exists, it calls `xCheckReservedLock`. **Only if that reports no lock** does it go on to treat the journal as hot. A zero-page database gets the journal deleted. A journal whose first byte is nonzero gets played back under an EXCLUSIVE lock, then deleted. With the constant 1, SQLite always concludes that "another connection is mid-write", and never plays a journal back. Scenario G shows the consequence: 200 committed rows, then an uncommitted `UPDATE` under `PRAGMA cache_size=2`, which forces a cache spill into the database file, then the worker terminated. On reopen, 196 rows showed the uncommitted value, and the journal was still in the pool.

**Is the constant intended?** Nothing says so, and every related source points the other way:
- The pool's own header comment says only that it "lacks all library-level concurrency support". The persistence docs (sqlite.org/wasm/doc/trunk/persistence.md) say it "does not support multiple simultaneous connections" and say nothing about crash recovery.
- The same bug in the sibling `"opfs"` VFS was reported by Roy Hashimoto on the SQLite forum (2024-06-08, [forum a2f573b00cda1372](https://sqlite.org/forum/info/a2f573b00cda1372)): "the impact of the bug is that hot journals cannot be played back in the event of a crash". Stephan Beal fixed it on 2024-06-12 on trunk and 3.46.x, "The corruption potential introduced by the OPFS VFS's buggy xCheckReservedLock() implementation is now fixed". Today `"opfs"` answers 0 (`index.mjs:13916-13932`, "xCheckReservedLock() is just a hint"). **The thread never mentions sahpool, and the pool kept the 1.**
- The pool is a port of wa-sqlite's AccessHandlePoolVFS. wa-sqlite's `FacadeVFS.jCheckReservedLock` answers 0.
- No sqlite-wasm GitHub issue or forum post about sahpool hot journals turned up.

**Verdict:** the premise holds. The constant is an unported fix, not a deliberate trade-off.

**One correction to the bean and to `worker.ts`:** a leftover journal does **not** hold its slot "for good". The next write transaction on that database opens the same path (the pool reuses the SAH), overwrites the header, and deletes the journal at commit (the default `journal_mode=DELETE`, which nothing in `web/src` changes). That commit also makes the torn pages permanent. The slot is freed at the next commit, not never.

### 2. One connection per pool file: established

| Who could open a pool file | Finding |
|---|---|
| A second tab, or a reloading tab's new worker | Each tab spawns its own dedicated `Worker` (`web/src/sync/SyncProvider.tsx:188`). SAHs are exclusive, and `acquireAccessHandles` is all-or-nothing, so a second worker's install fails until the first releases its handles (`openRetry.ts` header; a second live tab ends up `no-replica`). The pkm-ndcu partial-capacity race only lets the new worker create **new** random-named slots with `addCapacity`. It never shares a file. |
| The replica connection | One module-level `rawDb` (`worker.ts:36`). `openDb` runs only through the memoised `dbPromise` in `buildHandlers` (`workerHandlers.ts:150`). Each reopen follows `closeDb()`: `discardDbFile` → `closeDb` (`worker.ts:72`), and the `close` handler (`workerHandlers.ts:580`). |
| The carry | A different path (`CARRY_FILE`). It is opened and closed around each call (`carryStore.ts` `withCarry`, `finally close`), so it is never open twice. |
| diagnostics | Uses the same `db()` connection (`workerHandlers.ts` `diagnostics`). |
| `ATTACH`, `pauseVfs`, other workers | None in `web/src`. `sqlite3InitModule` appears only in `worker.ts` and the Node test helper `testDb.ts`. The Node build (`dist/node.mjs`) contains no sahpool VFS at all. |
| One benign edge | If `pragmas()` threw on a message `isSahPoolContention` matches, `openWithRetry` would build a second `rawDb` and leak the first. The leaked connection is idle (no transaction, so no lock). No realistic pragma error matches `/access handle/`, and the patched answer still reports a live writer's RESERVED lock to it. |

Inside the worker, JS is single-threaded and `wrapSqlite.transaction` runs its body synchronously. So no read transaction on a file can start while another connection to the same file is inside a write. Rollback therefore cannot hit a file that another live connection is writing. **The fix is safe.**

### 3. Options

| Option | Verdict |
|---|---|
| (a) Upgrade sqlite-wasm | **Not available.** 3.53.4-build1 and trunk still answer 1. |
| (b1) **pnpm patch** of `dist/index.mjs`: answer RESERVED only when a file this pool has open on the same path holds `lockType >= SQLITE_LOCK_RESERVED` | **Recommended.** About ten lines, where the lock state already lives. It applies to every pool file from the very first open, and gives the same answer the unix VFS gives within one process (lock state per inode). Keyed to the exact version, so an upgrade has to deal with it explicitly. It reaches the shipped worker because Vite bundles the patched `node_modules` file (browser condition → `index.mjs`). |
| (b2) pnpm patch answering a constant 0 (the `"opfs"` precedent) | Workable and smaller, but if a second connection to one file ever appeared in the worker, a reader would "roll back" a live writer's journal: destructive rather than just stale. b1 costs one method more and rules that out. |
| (b3) Runtime shim after `installOpfsSAHPoolVfs` | **Rejected.** The io-methods struct is closure-private (`opfsIoMethods`), reachable only through an open file's `pMethods` or by wrapping the VFS's `xOpen` function pointer. The lock state is in the pool's private map, so a shim would also have to shadow `xLock`/`xUnlock`. And it must land before the file's first read. It has more moving parts than b1 and the same upgrade exposure. |
| (c) journal modes | `TRUNCATE`/`PERSIST` detect hot journals by the same `hasHotJournal`, so no help, and `PERSIST` holds a slot permanently. `MEMORY`/`OFF` make a mid-commit kill certain corruption. **WAL** needs `xShmMap`, which the pool does not provide (io methods v1). It could only run with `locking_mode=EXCLUSIVE` and a heap wal-index. Its recovery replays only committed frames, so it would sidestep the bug. But upstream does not support WAL on this VFS (its import forces WAL off), and it changes the file format, the pool accounting (`-wal`), `discardDbFile` and the carry. Too large, and in unsupported territory. Revisit only if upstream declines b1. A larger `cache_size` only avoids spills: a kill during COMMIT's own page writes still tears the file. |
| (d) Delete or replay a leftover journal ourselves | Deleting a hot journal is exactly the corruption. Replaying one needs SQLite's pager. **No.** |

**Recommendation: (b1)**. Also draft the upstream report (Appendix A) so Arthur can file it. If upstream ships a fix, the patch is dropped at the next upgrade.

### 4. What changes in the docs and comments when it lands

- Commits on this VFS become atomic across a worker's death. The next open (the first read) plays back and removes the journal. This rewrites `sync-recovery.md` § Reset, rebase and file replacement (the "never rolls a journal back" sentence at :352-354 and the "not atomic" paragraph at :374-378), the first adoption-table row, the comments in `worker.ts:73-76` and `:94-95`, `poolCapacity.ts:46-52`, the doc comment of `adoptLeftoverCarry` (`workerHandlers.ts:183-187`) and the helper comment in `workerHandlers.test.ts:803-804`.
- The unreadable-carry escape stays. It now covers storage damage, and a write killed before its journal header was synced. A carry write that is cut short now rolls back to its previous contents, or to an empty file, which `carry.read()` reads as no rows.
- `docs/troubleshooting.md`: the pkm-h1c6 row's "origin unknown" gets its likely origin, and a new row covers pkm-87cf itself (the review reproduced it).

---

## Global Constraints

- TDD: every fix's failing test goes red, for the stated reason, before the fix.
- Every runtime file declares its FCIS pattern (`// pattern: Functional Core` / `// pattern: Imperative Shell`); pure predicates, classifiers and transforms live in Functional Core files. `pnpm check:fcis` forbids a Core file importing a value from a Shell module. (This plan adds only e2e support files, which are test files and exempt.)
- Code and test comments state the rule and carry NO bean id. Commit messages may carry the id. Leave existing bean ids in the untouched neighbouring comments alone; stripping them is pkm-9u3y.
- Docs land in the same branch: the doc corrections listed in Task 2, plus one row in `docs/troubleshooting.md` (symptom, cause, owning section, bean id). Any `docs/architecture/` edit goes through the `architecture-docs` skill; run `node .claude/skills/architecture-docs/check-docs.mjs <files>`.
- No route or docstring change, so there is no openapi/gen-types regeneration.
- Do **not** upgrade sqlite-wasm in this branch. The patch is keyed to `@sqlite.org/sqlite-wasm@3.53.0-build1`.
- Do **not** file the upstream report. Appendix A is for Arthur.
- E2E runs need a fresh `pnpm build` first (the e2e server serves `web/dist`). Run specs alone on the executor's port: `cd web && E2E_PORT=<port> node tooling/runPlaywright.mjs e2e/<spec>.spec.ts`. The orchestrator runs the full Playwright suite and `perf/check.sh` after merge. Do not run them.
- Final task: web `pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`; the new spec alone on E2E_PORT. The server is not touched. Then tick the bean checklist, add `## Summary of Changes`, complete the bean, and commit it with the code.
- Never write the two-word phrase that starts "load" and ends "bearing".
- **Files other wave-2 beans may also touch:** `web/src/replica/workerHandlers.ts` (a comment only here; pkm-yvka, pkm-xwb5), `web/src/replica/worker.ts` and `poolCapacity.ts` (comments; pkm-9u3y strips bean ids in both), `docs/architecture/sync-recovery.md` § Reset, rebase and file replacement and the Sync section of `docs/troubleshooting.md` (pkm-xjew and others), the e2e spec count in `docs/architecture/frontend.md` (pkm-rrzq adds specs, so count at execution time), and `web/pnpm-lock.yaml`.

## Review Focus

1. **A second connection to one pool file in the same worker** (a reader while a writer holds RESERVED). The patched VFS must leave the live journal alone. A constant-0 patch would play it back underneath the writer. Pinned by Task 1's test "a second connection in the same worker leaves a live writer's journal alone".
2. **A killed first transaction on a fresh file** (the carry's case: the file is created and filled in one transaction). The next open must see an empty database, not a torn one. Pinned by Task 1's test "a first transaction on a fresh file, cut short, leaves an empty database". The Task 2 doc wording about the carry depends on its result.
3. **The patch silently not applying** after a lockfile or version change. The build-output grep in Task 1 Step 7 and the full e2e suite catch it. `pnpm install` refuses a patch whose key no longer matches.
4. **A kill during COMMIT's page writes** rather than a spill. It is the same journal and the same playback, but no test can deterministically kill inside COMMIT. Covered by reasoning only. Reviewers should confirm that the spill test exercises the same `hasHotJournal` → playback path.
5. **iPadOS WebKit.** The patch is plain JS on the same SAH API, but the suite runs Chromium only. An optional manual check via the `ipad-simulator` skill is Arthur's call. Not a task.

---

### Task 1: Patch the pool VFS, proven by a Chromium kill-and-reopen spec

**Files:**
- Create: `web/e2e/sahpool-tool.ts` (spec-side driver for a test-only worker on the replica's OPFS pool)
- Create: `web/e2e/sahpool-tool.worker.mjs` (the tool worker's module source)
- Create: `web/e2e/replica-hot-journal.spec.ts`
- Create (via `pnpm patch-commit`): `web/patches/@sqlite.org__sqlite-wasm@3.53.0-build1.patch`
- Modify (via `pnpm patch-commit`): `web/pnpm-workspace.yaml` (`patchedDependencies`), `web/pnpm-lock.yaml`

**Interfaces:**
- Produces, in `web/e2e/sahpool-tool.ts`:
  ```ts
  export interface SqliteWasmSource { indexMjs: string; wasmBase64: string }
  /** dist/index.mjs and dist/sqlite3.wasm of the installed (patched) package,
   * located via createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"). */
  export function readSqliteWasmSource(): SqliteWasmSource;
  export interface SahpoolTool {
    files(): Promise<string[]>;                       // pool.getFileNames(); opens no database
    open(conn: string, file: string): Promise<void>;  // new pool.OpfsSAHPoolDb(file), kept under `conn`
    exec(conn: string, sql: string): Promise<Record<string, unknown>[]>; // rows as objects ([] for no result)
    kill(): Promise<void>;     // worker.terminate() as is: open transactions and all
    release(): Promise<void>;  // close every conn, pool.pauseVfs() (SAHs closed on return), then terminate
  }
  export async function startSahpoolTool(page: Page, source?: SqliteWasmSource): Promise<SahpoolTool>;
  ```
- Consumes: `SAH_POOL_INSTALL_OPTIONS` (`web/src/replica/openRetry.ts`), `REPLICA_FILE`, `journalOf` (`web/src/replica/poolCapacity.ts`). The spec imports these so the tool opens exactly the app's pool and path.

**Tool design (decisions the executor cannot infer):**
- The host page is `page.goto("/healthz")`. It is same-origin, so it sees the same OPFS as the app, and it neither boots the SPA nor spawns a replica worker. Put `test.use({ serviceWorkers: "block" })` at file level, so no PWA service worker ever intercepts.
- No request routing. Node reads the two package files from disk. `page.evaluate` turns them into blob URLs (`text/javascript`, `application/wasm`) and starts `new Worker(blobUrl(toolSource), { type: "module" })`. The tool does `const { default: init } = await import(indexUrl)` and `await init({ locateFile: () => wasmUrl })`. sqlite-wasm honours `locateFile`, and its `new URL(".", import.meta.url)` is inside a try (`index.mjs:316-318`). Workers are kept on `window` in an array. Each `SahpoolTool` call is one `page.evaluate` that posts `{ id, cmd, args }` and awaits `{ id, ok, result | error }`. Errors are rethrown in Node with the worker's message.
- Install: `installOpfsSAHPoolVfs({ ...SAH_POOL_INSTALL_OPTIONS })`, where the spec passes the options in. Retry the install every 100 ms for up to 5 s while the error message matches `/access handle|createSyncAccessHandle/i`, because a killed or closed worker releases its SAHs asynchronously. Fallback, only if a blob-imported module will not load: serve the same three files with `page.route("**/__e2e_sqlite/**")` and fetch them in the page. Record which approach worked in the commit message.
- `exec` uses `db.exec({ sql, returnValue: "resultRows", rowMode: "object" })`.

**Seed SQL (spec constants):**
- `CREATE TABLE e2e_probe(id INTEGER PRIMARY KEY, v TEXT NOT NULL, pad TEXT NOT NULL)`
- `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200) INSERT INTO e2e_probe SELECT i, 'committed', hex(zeroblob(250)) FROM n`. That is about 26 pages of 4 KiB. `'committed'` and `'uncommitd'` are the same length, so the torn pages keep their structure and the unpatched app reads them without SQLITE_CORRUPT.
- `TEAR = ["PRAGMA cache_size=2", "BEGIN", "UPDATE e2e_probe SET v = 'uncommitd'"]` (no COMMIT). This is review scenario G.
- The app leaves an unknown table alone: `init` on a file with no `sync_client_meta` runs `installSchema` (all `CREATE … IF NOT EXISTS`), and a bootstrap snapshot only `DELETE`s its own tables (`apply.ts:78-82`).

- [ ] **Step 1: Write the tool files** (`sahpool-tool.ts`, `sahpool-tool.worker.mjs`) to the interface above.

- [ ] **Step 2: Write the proving test** in `web/e2e/replica-hot-journal.spec.ts`

```ts
test("the app rolls back a replica transaction a killed worker left, on its next open", async ({ page, context }) => {
  await page.goto("/healthz");
  const writer = await startSahpoolTool(page);
  await writer.open("a", REPLICA_FILE);
  for (const sql of [CREATE_PROBE, SEED_PROBE, ...TEAR]) await writer.exec("a", sql);
  await writer.kill();

  const inspector = await startSahpoolTool(page);
  expect(await inspector.files()).toContain(journalOf(REPLICA_FILE));   // the kill left a journal
  await inspector.release();

  const app = await context.newPage();
  await login(app);                                   // same helper shape as offline.spec.ts
  await app.waitForFunction(() => performance.getEntriesByName("pkm:replica-ready").length > 0);
  await app.close();                                  // its worker's SAHs release; the tool retries

  const reader = await startSahpoolTool(page);
  await reader.open("a", REPLICA_FILE);
  expect(await reader.exec("a", "SELECT v, count(*) AS n FROM e2e_probe GROUP BY v"))
    .toEqual([{ v: "committed", n: 200 }]);
  expect(await reader.exec("a", "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  expect(await reader.files()).not.toContain(journalOf(REPLICA_FILE));
  await reader.release();
});
```

The app, not the reader, must be the one that rolls back. The app's `init` reads the file, and a fresh file then gets `installSchema`. Both happen before `pkm:replica-ready` is marked. Unpatched, that first write commit reuses and deletes the leftover journal, which makes the torn pages permanent. So the reader's result reflects what the app did. A journal the app itself leaves at `app.close()` belongs to the app's own later write, not to `e2e_probe`.

- [ ] **Step 3: Build and run it; verify red**

Run: `cd web && pnpm build && E2E_PORT=<port> node tooling/runPlaywright.mjs e2e/replica-hot-journal.spec.ts`
Expected: FAIL on the `GROUP BY v` assertion, with a received value that includes `{ v: "uncommitd", n: <most of 200> }` (the review saw 196). If it fails for any other reason (a missing table, a tool load error, no journal after the kill), fix the harness until the failure is this one. Do not go on until it is.

- [ ] **Step 4: Make the patch**

Run: `cd web && pnpm patch @sqlite.org/sqlite-wasm@3.53.0-build1 --edit-dir <scratch>/sqlite-wasm-patch`, and edit `<scratch>/sqlite-wasm-patch/dist/index.mjs` only (`node.mjs` has no sahpool, and `sqlite3-worker1.mjs` is unused). Keep this exact change:

In `class OpfsSAHPool`, directly after `getOFileForS3File(pFile)`:
```js
/** Whether a file this pool has open on `path` holds RESERVED or a
    stronger lock. A pool's files are reachable only through its own
    exclusive SAHs, so no other worker or tab can hold one. */
isPathReserved(path) {
  for (const f of this.#mapS3FileToOFile_.values()) {
    if (f.path === path && f.lockType >= capi.SQLITE_LOCK_RESERVED) return true;
  }
  return false;
}
```
In `ioMethods.xCheckReservedLock`, replace `wasm.poke32(pOut, 1);` with:
```js
/* SQLite plays a leftover journal back only when this reports no
   RESERVED lock. Answering 1 always made every journal a killed
   worker left look like a live writer's, so it was never rolled back. */
wasm.poke32(pOut, pool.isPathReserved(pool.getOFileForS3File(pFile).path) ? 1 : 0);
```
Then run `pnpm patch-commit <scratch>/sqlite-wasm-patch`.
Expected: `web/patches/@sqlite.org__sqlite-wasm@3.53.0-build1.patch` exists; `web/pnpm-workspace.yaml` gains a `patchedDependencies` entry keyed `@sqlite.org/sqlite-wasm@3.53.0-build1`; `pnpm-lock.yaml` records it. If `patch-commit` rewrote `pnpm-workspace.yaml` and dropped its existing comments, restore them. Add a two-line YAML comment above `patchedDependencies` saying what the patch fixes, and that an upgrade must carry it forward or drop it once upstream fixes the VFS.

- [ ] **Step 5: Add the two guard tests** to the same spec, each in its own fresh context (Playwright's default per test, so each starts with an empty OPFS)

```ts
test("a second connection in the same worker leaves a live writer's journal alone", async ({ page }) => {
  // tool on /healthz; file "/e2e-two-connections.sqlite3"
  // a: CREATE_PROBE, SEED_PROBE, ...TEAR          (a holds RESERVED, pages spilled)
  // b: open the same file; SELECT count(*) AS n FROM e2e_probe  -> [{ n: 200 }]
  // files() contains "/e2e-two-connections.sqlite3-journal"     (b did not play it back)
  // a: COMMIT
  // b: SELECT v, count(*) AS n FROM e2e_probe GROUP BY v  -> [{ v: "uncommitd", n: 200 }]
  // b: PRAGMA integrity_check -> [{ integrity_check: "ok" }]; release()
});

test("a first transaction on a fresh file, cut short, leaves an empty database", async ({ page }) => {
  // writer: open "/e2e-fresh.sqlite3"; "PRAGMA cache_size=2", "BEGIN", CREATE_PROBE, SEED_PROBE; kill()
  // reader: files() contains "/e2e-fresh.sqlite3-journal"
  // reader: open it; SELECT count(*) AS n FROM sqlite_master -> [{ n: 0 }]
  // reader: files() does not contain the journal; release()
});
```

- [ ] **Step 6: Reinstall, rebuild, run the spec; verify green**

Run: `cd web && pnpm install && pnpm build && E2E_PORT=<port> node tooling/runPlaywright.mjs e2e/replica-hot-journal.spec.ts`
Expected: 3 passed. If the fresh-file test fails, do not bend it. Record what the reopened file held, and tell Task 2's author (yourself) so that the carry wording in Task 2 Step 2 follows what was observed.

- [ ] **Step 7: Prove the patch ships and that the guard test discriminates**

Run: `grep -c isPathReserved web/dist/app-assets/worker-*.js`. Expected: at least 1.
Then, as a scratch check that is **not committed**: copy the spec to `e2e/scratch-constant0.spec.ts`, and have it call `startSahpoolTool(page, { ...src, indexMjs: src.indexMjs.replace("pool.isPathReserved(pool.getOFileForS3File(pFile).path) ? 1 : 0", "0") })` with `const src = readSqliteWasmSource()`, asserting the replace changed the string. Run only the second-connection test in it. Expected: FAIL (the journal is gone after b's read, or the counts are mixed). Delete the scratch spec. Never edit `node_modules` in place: pnpm hardlinks it from the shared store.

- [ ] **Step 8: Commit**

```bash
git add web/e2e/sahpool-tool.ts web/e2e/sahpool-tool.worker.mjs web/e2e/replica-hot-journal.spec.ts \
        web/patches web/pnpm-workspace.yaml web/pnpm-lock.yaml
git commit -m "fix(pkm-87cf): roll back a killed worker's journal on the SAH pool VFS"
```

### Task 2: Comments, architecture docs and troubleshooting say what now holds

**Files:**
- Modify: `web/src/replica/worker.ts:73-76` (`discardDbFile`), `:94-95` (`carryFiles.unlink`)
- Modify: `web/src/replica/poolCapacity.ts:46-52` (`MIN_POOL_CAPACITY` doc)
- Modify: `web/src/replica/workerHandlers.ts:183-187` (`adoptLeftoverCarry` doc, first escape)
- Modify: `web/src/replica/workerHandlers.test.ts:803-804` (helper comment)
- Modify: `docs/architecture/sync-recovery.md` § Reset, rebase and file replacement (:352-354, :374-378, adoption table row 1)
- Modify: `docs/architecture/sync-and-offline.md` § The replica (:308)
- Modify: `docs/architecture/frontend.md` § Build notes (:484) and the e2e spec count (:462)
- Modify: `docs/troubleshooting.md` § Sync and offline (the pkm-h1c6 row at :121; new row after the pkm-9xg0 row)

**Interfaces:** none (text only). Values used: the patch path and the e2e spec name from Task 1.

- [ ] **Step 1: Rewrite the code comments** to state the current rules. No bean ids.
  - `discardDbFile` / `carryFiles.unlink`: the journal goes with its file because it describes only that file, and every pool file claims a slot. Drop the "never rolled back / for good" claims.
  - `MIN_POOL_CAPACITY`: a rollback journal lives while a write transaction is open. One a killed worker left lives until the next open of its database plays it back. `PEAK_POOL_FILES` counts both journals, so the peak never depends on that timing. The values stay the same.
  - `adoptLeftoverCarry`, first escape: a carry write cut short is rolled back on the next open, to the carry's previous rows or to an empty file that reads as none. A carry that still cannot be read means storage damage (or a journal whose header never synced). The write precedes the unlink either way, so the replica still holds the rows.
  - Test helper comment: "a new file damaged in storage" instead of "torn by a worker killed mid-commit".

- [ ] **Step 2: Docs, through the `architecture-docs` skill**
  - `sync-and-offline.md` § The replica: a short note, bold lead **"A commit is atomic across the worker's death."** It says that `web/patches/@sqlite.org__sqlite-wasm@3.53.0-build1.patch` makes the pool VFS report RESERVED only when a file it has open on that path holds it, so the next open of a file plays back and removes a killed worker's journal. It gives the precondition (one live connection per pool file: SAHs are exclusive across workers and tabs, and the worker keeps one connection per file). It names the proof, `web/e2e/replica-hot-journal.spec.ts`. This is the section the new troubleshooting row links to.
  - `sync-recovery.md`: the :352-354 sentence becomes "the journal goes too, since it describes only that file". The :374-378 paragraph drops "not atomic" and keeps the carry's guarantee (at every step a file not being written holds every row), linking the replica section above for why a cut-short commit rolls back. Adoption table row 1, "Why no row is lost": a cut-short carry write rolls back on the next open (to fewer rows or none); an unreadable carry is storage damage; the write precedes the unlink, so the replica still holds the rows. Make this wording match Task 1 Step 6's fresh-file result.
  - `frontend.md` § Build notes: one sentence saying `@sqlite.org/sqlite-wasm` carries a version-keyed pnpm patch (link the replica section), and an upgrade must carry it forward or drop it once upstream fixes the VFS. In § Testing, fix the spec count to `ls web/e2e/*.spec.ts | wc -l` at execution time (it already reads "thirty" against 32 files before this branch).
  - Run: `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/sync-and-offline.md docs/architecture/sync-recovery.md docs/architecture/frontend.md`. Expected: no findings.

- [ ] **Step 3: Troubleshooting**
  - pkm-h1c6 row, Cause: replace "origin unknown; seen after app switching on iPadOS" with "most likely a worker killed mid-commit on iPadOS, whose journal the pool VFS never played back (see the pkm-87cf row)".
  - New row after pkm-9xg0: Symptom "A replica reopened after its worker was killed mid-write holds that transaction's uncommitted rows, or later reads as `SQLITE_CORRUPT`; `/pkm-replica.sqlite3-journal` stays in the pool until the next commit". Cause "sqlite-wasm's opfs-sahpool VFS answered `xCheckReservedLock` with 1 every time, so SQLite took every leftover journal for a live writer's and never played it back. A version-keyed pnpm patch now reports a RESERVED lock only when this pool holds one on the file". Where "[sync-and-offline.md § The replica](architecture/sync-and-offline.md#the-replica)". Ref `pkm-87cf`.

- [ ] **Step 4: Verify the comment-only code edits changed nothing**

Run: `cd web && pnpm typecheck && pnpm vitest run src/replica`. Expected: clean, all passed.

- [ ] **Step 5: Commit**

```bash
git add web/src/replica/worker.ts web/src/replica/poolCapacity.ts web/src/replica/workerHandlers.ts \
        web/src/replica/workerHandlers.test.ts docs/architecture docs/troubleshooting.md
git commit -m "docs(pkm-87cf): replica commits are atomic across worker death; corrected the no-rollback claims, added the patch note and troubleshooting row"
```

### Task 3: Final verification and bean

- [ ] **Step 1:** Run `cd web && pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`. Expected: all pass.
- [ ] **Step 2:** Run `cd web && E2E_PORT=<port> node tooling/runPlaywright.mjs e2e/replica-hot-journal.spec.ts`. Expected: 3 passed.
- [ ] **Step 3:** Update the bean.
  - Tick "Confirm the behaviour upstream", noting the finding: an unported fix, per the forum thread in Appendix A.
  - Reword "Report it to sqlite-wasm…" to "Draft the upstream report (plan Appendix A); filing is Arthur's call", and tick it.
  - Tick "Confirm only one connection…" and the "If shimmed" item.
  - Add `## Summary of Changes`, including the investigation's correction that a leftover journal is reused and deleted by the next commit rather than held for good.
  - Run `beans update pkm-87cf --status completed` (or whatever the beans CLI uses to complete; see `beans prime`).
- [ ] **Step 4:** Commit the bean file: `git add .beans && git commit -m "chore(pkm-87cf): complete bean"`.

---

## Appendix A: upstream report (draft; Arthur decides whether to file)

> **Superseded, not filed (2026-09-29).** The same bug was reported
> independently on the SQLite forum the day this shipped:
> https://sqlite.org/forum/forumpost/ccf76ca422. It names the same method,
> symptom and fix, and confirms it on npm 3.53.4 and trunk across Chromium,
> Firefox and WebKit. Filing this draft would duplicate that thread; a reply
> there with our reproduction (195 of 200 rows uncommitted after a kill, seen
> in the field as damaged replicas on iPad) is the useful contribution. The
> draft is kept below for that reply. Status and the upgrade procedure live in
> `docs/architecture/sqlite-wasm-patch.md`.

Where: the SQLite forum (https://sqlite.org/forum). The VFS source lives in the core tree (`ext/wasm/api/sqlite3-vfs-opfs-sahpool.c-pp.js`), and the sibling `"opfs"` fix was handled there. The npm packaging repo (github.com/sqlite/sqlite-wasm) is the wrong place.

> **Title:** opfs-sahpool: xCheckReservedLock() always reports a reserved lock, so hot journals are never rolled back
>
> In the opfs-sahpool VFS (checked in 3.53.0, 3.53.4 and trunk as of 2026-09-29), `xCheckReservedLock()` unconditionally writes 1 to its output:
>
> ```js
> xCheckReservedLock: function(pFile,pOut){
>   const pool = getPoolForPFile(pFile);
>   pool.log('xCheckReservedLock');
>   pool.storeErr();
>   wasm.poke32(pOut, 1);
>   return 0;
> },
> ```
>
> `hasHotJournal()` in pager.c only treats a leftover `-journal` as hot when `xCheckReservedLock()` reports no RESERVED lock. So with this VFS a journal left behind by a worker that died mid-transaction is never played back. The database keeps whatever pages had reached it: spilled pages of an uncommitted transaction, or a partial set of a commit's page writes. The next write transaction on that database then reuses and deletes the journal, and that makes the damage permanent.
>
> This is the same defect Roy Hashimoto reported for the "opfs" VFS in forum post a2f573b00cda1372 (June 2024), which was fixed for "opfs" in 3.46.x ("The corruption potential introduced by the OPFS VFS's buggy xCheckReservedLock() implementation is now fixed"). The sahpool VFS kept the constant. wa-sqlite's AccessHandlePoolVFS, which this VFS is ported from, reports 0.
>
> **Reproduction** (Chromium, dedicated worker, any page on one origin):
>
> Worker A:
> ```js
> const sqlite3 = await sqlite3InitModule();
> const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'hj-repro' });
> const db = new pool.OpfsSAHPoolDb('/repro.db');
> db.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL, pad TEXT NOT NULL);
>          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200)
>          INSERT INTO t SELECT i, 'before', hex(zeroblob(250)) FROM n;`);
> db.exec("PRAGMA cache_size=2; BEGIN; UPDATE t SET v='after!';");  // no COMMIT
> postMessage('ready');
> ```
> The page calls `workerA.terminate()` on 'ready'. Then worker B (retrying `installOpfsSAHPoolVfs` until A's access handles are released):
> ```js
> const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'hj-repro' });
> pool.getFileNames();                    // includes '/repro.db-journal'
> const db = new pool.OpfsSAHPoolDb('/repro.db');
> db.selectValue("SELECT count(*) FROM t WHERE v='after!'");
> ```
> **Expected:** 0 (the hot journal is rolled back and removed). **Actual:** most of the 200 rows read `'after!'` (we saw 196), and the journal is still listed.
>
> **Suggested fix:** report RESERVED only when a file this pool has open on the same path holds `lockType >= SQLITE_LOCK_RESERVED`. That is the per-process answer the unix VFS gives, and it keeps a second in-thread connection from playing back a live writer's journal:
>
> ```js
> // OpfsSAHPool
> isPathReserved(path){
>   for(const f of this.#mapS3FileToOFile_.values()){
>     if(f.path===path && f.lockType>=capi.SQLITE_LOCK_RESERVED) return true;
>   }
>   return false;
> }
> // ioMethods.xCheckReservedLock
> wasm.poke32(pOut, pool.isPathReserved(pool.getOFileForS3File(pFile).path) ? 1 : 0);
> ```
>
> Answering a constant 0, as "opfs" now does, would also restore recovery. Because the pool's SAHs are exclusive, no other thread or tab can hold a lock on these files. We carry the patch above downstream in the meantime.
