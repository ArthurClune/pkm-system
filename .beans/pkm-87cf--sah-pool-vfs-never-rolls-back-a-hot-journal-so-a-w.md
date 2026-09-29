---
# pkm-87cf
title: SAH pool VFS never rolls back a hot journal, so a worker killed mid-commit leaves a torn replica
status: completed
type: bug
priority: high
created_at: 2026-09-29T14:26:50Z
updated_at: 2026-09-29T15:42:41Z
parent: pkm-a4t2
---

Found by the adversarial review of pkm-9xg0 (F1, finding I-2). Outside F1's
scope, but on every replica write path.

## What

sqlite-wasm's opfs-sahpool VFS answers `xCheckReservedLock` with 1 every time
(`web/node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs` ~14588-14593, build
3.53.0-build1):

```js
xCheckReservedLock: function(pFile, pOut) {
  ...
  wasm.poke32(pOut, 1);
  return 0;
},
```

So SQLite's `hasHotJournal` always concludes that another connection holds
RESERVED, and never treats a leftover `-journal` as hot. A journal left by a
worker killed mid-commit is never rolled back and never removed.

## Evidence (Chromium, review scenario G)

200 rows committed; then an uncommitted UPDATE with `cache_size=2` (forcing a
cache spill into the database file) and the worker terminated. On reopen, 196
of the 200 rows showed the uncommitted value, and the journal was still in the
pool.

## Consequences

- Every "a commit is atomic" assumption about the replica across a worker's
  death is false on this VFS: durable enqueue, snapshot apply, `rebuildSchema`,
  the carry write and import. A kill inside a commit's page writes leaves a
  torn file, not a rolled-back one.
- A candidate origin of the iPad damaged-file incidents in
  `docs/troubleshooting.md` (the pkm-h1c6 row: "origin unknown; seen after app
  switching on iPadOS"): an iPad suspending or killing the PWA mid-write.
- A leftover journal holds a pool slot until something unlinks it.
- pkm-9xg0 now copes with a torn carry or a torn new replica during adoption
  (discard the torn carry; replace a replica that cannot take the rows), but
  that only covers the file-replacement path.

## Next steps

- [x] Confirm the behaviour upstream (is the constant 1 intended for the
      single-connection pool, and is hot-journal rollback knowingly given up?)
      Not intended: an unported fix. The same bug in the sibling "opfs" VFS
      was reported and fixed in 2024 (forum a2f573b00cda1372); sahpool kept
      the constant through 3.53.4-build1 and trunk (plan Investigation §1).
- [x] Draft the upstream report (plan Appendix A); filing is Arthur's call
- [x] Confirm only one connection in the worker ever opens each pool file
      (replica, carry), then consider a VFS shim or patch answering 0 from
      `xCheckReservedLock`, so a hot journal is rolled back on the next open
      (confirmed, plan Investigation §2; patched to answer RESERVED only
      when this pool holds it on the path, rather than a constant 0)
- [x] If shimmed: an e2e reproduction (kill mid-commit, reopen, the
      uncommitted change is gone and the journal removed), and revisit the
      journal comments in `worker.ts`/`poolCapacity.ts` and
      sync-recovery.md § Reset, rebase and file replacement

## Summary of Changes

- `web/patches/@sqlite.org__sqlite-wasm@3.53.0-build1.patch`, declared in
  `web/pnpm-workspace.yaml` `patchedDependencies` and keyed to the exact
  version: the opfs-sahpool VFS's `xCheckReservedLock` now reports RESERVED
  only when a file this pool has open on the same path holds
  `lockType >= SQLITE_LOCK_RESERVED` (new `OpfsSAHPool.isPathReserved`).
  Patched in `dist/index.mjs` (the build the worker bundles) and
  `dist/sqlite3-worker1.mjs` (Vite emits it as an unused asset). An upgrade
  fails `pnpm install` ("patches were not used") until the patch is carried
  forward or dropped.
- `web/e2e/replica-hot-journal.spec.ts` (+ `sahpool-tool.ts`,
  `sahpool-tool.worker.mjs`, a test-only worker on the app's pool): the app
  rolls back a killed worker's uncommitted spill on its next open (red
  before: 195 of 200 rows uncommitted); a second in-worker connection leaves
  a live writer's journal alone (fails under a constant-0 patch); a first
  transaction on a fresh file, cut short, leaves an empty database (red
  before: SQLITE_NOTADB).
- Investigation correction: a leftover journal was not held "for good". The
  next write transaction reused and deleted it at commit, which made the torn
  pages permanent.
- Comments in `worker.ts`, `poolCapacity.ts`, `workerHandlers.ts` (+ test
  helper) and docs (`sync-and-offline.md` § The replica, `sync-recovery.md` §
  Reset, rebase and file replacement, `frontend.md` build notes and spec
  count, two troubleshooting rows) now say commits are atomic across a
  worker's death.

## Upstream report

The bug was reported upstream independently on 2026-09-29, the day this
bean shipped: https://sqlite.org/forum/forumpost/ccf76ca422 (Daniel
Steigerwald). Same VFS (opfs-sahpool), same method (`xCheckReservedLock`
answering a constant 1), same symptom (a half-applied transaction after
`worker.terminate()`, a tab close or a reload, with `integrity_check`
still "ok"), and the same fix (report RESERVED only when the pool really
holds it). It confirms the bug on npm 3.53.4 and trunk `1f7010d4` in
Chromium 153, Firefox 155, WebKit 26.6 and Safari 26.6.2, and cites the
older "opfs" VFS precedent (forum a2f573b00cda1372, check-in `c298b8ba`,
June 2024). No SQLite developer had replied as of 2026-09-29.

Our drafted report (plan Appendix A) is not filed: it would duplicate that
thread. Watch the thread and the sqlite-wasm release notes; when a release
fixes opfs-sahpool, drop the patch per
`docs/architecture/sqlite-wasm-patch.md` § Upgrading sqlite-wasm.
