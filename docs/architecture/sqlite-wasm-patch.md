# The sqlite-wasm patch

The web replica runs a patched `@sqlite.org/sqlite-wasm`. Upstream's
opfs-sahpool VFS never rolls back a hot journal, so a worker killed mid-commit
leaves a half-applied transaction that `integrity_check` still calls "ok".
Upstream has fixed this on trunk, but no npm release carries the fix yet, so
the patch stays until one does. Then delete the patch and this file together
(see [Upgrading](#upgrading-sqlite-wasm)).
Known failures live in [troubleshooting.md](../troubleshooting.md).

## What it changes

SQLite asks `xCheckReservedLock` only from `hasHotJournal()`. A leftover
`-journal` counts as hot, and is played back, only when no connection holds a
RESERVED lock on its database. Upstream's pool answers a constant 1, so every
leftover journal looks like a live writer's and is never rolled back.

| Patched file | Change |
|---|---|
| `dist/index.mjs` | `xCheckReservedLock` answers `pool.isPathReserved(path)`; the new `OpfsSAHPool.isPathReserved` is true only when a file this pool has open on that path holds `SQLITE_LOCK_RESERVED` or stronger |
| `dist/sqlite3-worker1.mjs` | The same edit. The app never runs this build, but Vite bundles and precaches it |

The fix is safe only because every connection to a pool file lives in that
pool: the pool holds exclusive access handles, so no other worker or tab can
open the file. [sync-and-offline.md § The replica](sync-and-offline.md#the-replica)
states what the replica relies on it for.

## How it is applied

| Piece | Role |
|---|---|
| `web/package.json` | Pins `@sqlite.org/sqlite-wasm` to `3.53.0-build1`, no range |
| `web/pnpm-workspace.yaml` | `patchedDependencies` maps that exact version to the patch file |
| `web/patches/@sqlite.org__sqlite-wasm@3.53.0-build1.patch` | The diff against the published `dist/` files |
| `web/pnpm-lock.yaml` | Records the package as `3.53.0-build1(patch_hash=…)`, so a frozen install fails if the patch and lockfile disagree |
| `web/e2e/replica-hot-journal.spec.ts` | Kills a writer mid-transaction in real Chromium and checks that the next open rolls it back. Its helper worker loads the installed `index.mjs`, so an unpatched install fails it |

Every `pnpm install` applies the patch into `node_modules`: the dev checkout,
each worktree, and the production deploy, whose `deploy/update.sh` runs
`pnpm install --frozen-lockfile` before building. Nothing is vendored or copied
by hand.

## Upgrading sqlite-wasm

Bumping the version leaves the patch keyed to one that is no longer installed,
and pnpm refuses to install ("The following patches were not used"). So an
upgrade cannot drop the fix silently; it forces one of two paths.

| Upstream release | Do |
|---|---|
| Fixes opfs-sahpool's `xCheckReservedLock` | Remove the `patchedDependencies` entry and the patch file, delete this doc and its row in [overview.md](overview.md), and reword the replica section's pointer here |
| Does not | `pnpm patch @sqlite.org/sqlite-wasm@<new>`, re-apply the two edits, `pnpm patch-commit <dir>`, then update `patchedDependencies` and the version pin |

Either way, run `web/e2e/replica-hot-journal.spec.ts` (or `pnpm verify`)
before merging. A patch that applies but no longer works shows only there.

## Upstream status

Stephan Beal fixed opfs-sahpool on 2026-09-30, on trunk and on `branch-3.53`,
in [forumpost/ccf76ca422](https://sqlite.org/forum/forumpost/ccf76ca422). The
fix goes further than this patch: an in-process lock table also covers
overlapping handles on one file, and the VFS's `xSleep` becomes a no-op so
that `busy_timeout` cannot freeze the worker.

| Check-in | Trunk | `branch-3.53` |
|---|---|---|
| Hot-journal rollback (`xCheckReservedLock`) | `9168a6f1be` | `ea1d55e202e6e` |
| Per-file lock table | `9e2caaa382ce` | `079400229e09` |
| No-op `xSleep` | `c9dd4d88e4` | `f774529206` |

No npm release carries these yet. `3.53.4-build2` (2026-10-02) is built from a
2026-07-24 source and still answers 1. Upstream said it does not expect another
3.53.x release, so the fix will probably first ship in 3.54.0.

To test a candidate release, find opfs-sahpool's `xCheckReservedLock` in its
`dist/index.mjs`. If it still calls `wasm.poke32(pOut, 1)`, the release lacks
the fix. The older opfs VFS had the same defect, fixed in June 2024 by check-in
`c298b8ba` ([forumpost/a2f573b00cda1372](https://sqlite.org/forum/forumpost/a2f573b00cda1372)).
