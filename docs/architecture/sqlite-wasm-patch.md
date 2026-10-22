# The sqlite-wasm patch

The web replica runs a patched `@sqlite.org/sqlite-wasm`. Upstream's
opfs-sahpool VFS never rolls back a hot journal, so a worker killed mid-commit
leaves a half-applied transaction that `integrity_check` still calls "ok".
The patch stays until an npm release carries upstream's fix; then delete the
patch and this file together ([Upgrading](#upgrading-sqlite-wasm)).

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
pool: its exclusive access handles keep every other worker and tab out.

## How it is applied

| Piece | Role |
|---|---|
| `web/package.json` | Pins `@sqlite.org/sqlite-wasm` to `3.53.0-build1`, no range |
| `web/pnpm-workspace.yaml` | `patchedDependencies` maps that exact version to the patch file |
| `web/patches/@sqlite.org__sqlite-wasm@3.53.0-build1.patch` | The diff against the published `dist/` files |
| `web/pnpm-lock.yaml` | Records `3.53.0-build1(patch_hash=…)`, so a frozen install fails if patch and lockfile disagree |
| `web/e2e/replica-hot-journal.spec.ts` | Kills a writer mid-transaction in Chromium and checks the next open rolls it back, using the installed `index.mjs`, so an unpatched install fails it |

Every `pnpm install` applies the patch, including the production deploy's
`pnpm install --frozen-lockfile` in `deploy/update.sh`. Nothing is vendored.

## Upgrading sqlite-wasm

Bumping the version leaves the patch keyed to one no longer installed, and pnpm
refuses to install ("The following patches were not used"), so an upgrade
cannot drop the fix silently. Upstream fixed the VFS on trunk
([forumpost/ccf76ca422](https://sqlite.org/forum/forumpost/ccf76ca422)); the
first release with it is expected to be 3.54.0. A release lacks the fix if
opfs-sahpool's `xCheckReservedLock` in its `dist/index.mjs` still calls
`wasm.poke32(pOut, 1)`.

| Upstream release | Do |
|---|---|
| Has the fix | Remove the `patchedDependencies` entry and the patch file, delete this doc and its row in [overview.md](overview.md), and reword the replica section's pointer here |
| Lacks it | `pnpm patch @sqlite.org/sqlite-wasm@<new>`, re-apply the two edits, `pnpm patch-commit <dir>`, then update `patchedDependencies` and the version pin |

Either way, run `web/e2e/replica-hot-journal.spec.ts` (or `pnpm verify`)
before merging. A patch that applies but no longer works shows only there.
