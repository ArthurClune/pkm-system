---
# pkm-rry9
title: Upgrade sqlite-wasm to 3.54.1 and drop the opfs-sahpool patch
status: completed
type: task
priority: normal
created_at: 2026-10-28T20:37:45Z
updated_at: 2026-10-28T20:50:11Z
---

Upstream 3.54.1-build1 fixes opfs-sahpool xCheckReservedLock (now answers hasReservedLock(path), backed by real per-path locks in lockFile/unlockFile), so the pkm-87cf patch can go per docs/architecture/sqlite-wasm-patch.md § Upgrading.

- [x] Bump the pin to 3.54.1-build1, drop patchedDependencies and the patch file
- [x] Delete sqlite-wasm-patch.md, its overview row, reword pointers
- [x] replica-hot-journal e2e passes on the unpatched 3.54.1
- [x] pnpm verify
- [x] proptest web, perf frontend

## Summary of Changes

- `@sqlite.org/sqlite-wasm` pinned to 3.54.1-build1; the pkm-87cf patch, its `patchedDependencies` entry and `docs/architecture/sqlite-wasm-patch.md` are gone. 3.54.1's opfs-sahpool answers `xCheckReservedLock` from real per-path locks (`OpfsSAHPool.lockFile`/`hasReservedLock`), which covers what the patch did.
- Behaviour change: the pool now arbitrates locks between connections to one file in a worker, as os_unix.c does. A second connection reading while another holds EXCLUSIVE gets SQLITE_BUSY. The app keeps one connection per pool file (replica, carry), so only the e2e's second-connection test saw it; it now expects SQLITE_BUSY and still checks the writer's journal survives and commits.
- Verified: replica-hot-journal e2e (3/3) on the unpatched build, `pnpm verify` (5751 unit, 102 e2e), `proptest/check.sh web` (80 passed), `perf/check.sh frontend` (no changes).
