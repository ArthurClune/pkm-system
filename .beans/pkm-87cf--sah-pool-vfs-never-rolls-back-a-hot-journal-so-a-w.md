---
# pkm-87cf
title: SAH pool VFS never rolls back a hot journal, so a worker killed mid-commit leaves a torn replica
status: todo
type: bug
priority: high
created_at: 2026-09-29T14:26:50Z
updated_at: 2026-09-29T14:26:50Z
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

- [ ] Confirm the behaviour upstream (is the constant 1 intended for the
      single-connection pool, and is hot-journal rollback knowingly given up?)
- [ ] Report it to sqlite-wasm with the scenario-G reproduction
- [ ] Confirm only one connection in the worker ever opens each pool file
      (replica, carry), then consider a VFS shim or patch answering 0 from
      `xCheckReservedLock`, so a hot journal is rolled back on the next open
- [ ] If shimmed: an e2e reproduction (kill mid-commit, reopen, the
      uncommitted change is gone and the journal removed), and revisit the
      journal comments in `worker.ts`/`poolCapacity.ts` and
      sync-recovery.md § Reset, rebase and file replacement
