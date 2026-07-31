---
# pkm-ndcu
title: 'E2E suite is load-sensitive: edit.spec.ts and paste.spec.ts flake on a busy machine'
status: completed
type: bug
priority: normal
created_at: 2026-07-30T07:57:36Z
updated_at: 2026-07-31T09:11:39Z
---

`pnpm verify`'s Playwright suite is not reliably green on a loaded machine. Observed repeatedly during pkm-0wg9 (2026-07-29), always as an outline-editor timeout, at several different line numbers:

- `web/e2e/edit.spec.ts` — failures seen at `:124`, `:220` and `:308` across runs
- `web/e2e/paste.spec.ts:53` — first sighting, new to the flake list

Every failure passed on a rerun with **zero code changes** in between.

This is confirmed pre-existing, not caused by pkm-0wg9. It was established by baseline-measurement rather than by assumption: `67e3303`'s `web/src` was checked out in place, rebuilt, and E2E run twice — 1 pass, 1 failure at `edit.spec.ts:124`. A reviewer independently confirmed via `git diff --stat` that `server/`, `web/e2e/` and `playwright.config.ts` were byte-identical across the whole branch.

Prior related history: `edit.spec.ts:308` load-sensitivity was already noted in the 2026-07-27 batch, and a "Server rejected a change. Active outlines repaired." banner (seen during one of these failures) traced in pkm-c9hp to OPFS SAH-pool contention on reload rather than any server-side rejection — so storage contention under load is the leading hypothesis, not sync logic.

Worth fixing because it erodes trust in the gate: a real regression in these specs would currently be dismissed as "the usual flake".

- [x] Reproduce deliberately under load (parallel workers, or an artificial CPU load)
- [x] Confirm or rule out OPFS SAH-pool contention as the mechanism
- [x] Fix the root cause, or make the affected waits robust rather than time-based
- [x] Run the suite repeatedly under load to show it holds

## Summary of Changes

**Root cause (captured, not guessed): the replica's OPFS SAH pool can start
life with a capacity of ONE, which makes every local write fail forever.**

`installOpfsSAHPoolVfs` sizes its pool from whatever files it finds in its
opaque directory, and only falls back to the default `initialCapacity` of 6
when it finds *nothing*:

```js
isReady = reset().then(() =>
  this.getCapacity() ? undefined : this.addCapacity(initialCapacity))
```

A worker spawned mid-navigation can enumerate that directory while the
sibling worker it is replacing is still creating the pool files, and come
away holding a single access handle. `getCapacity()` is 1, which is truthy,
so it never tops itself up. Opening `/pkm-replica.sqlite3` claims that one
slot, and the SAHPool VFS is a *fixed* pool in which every file SQLite opens
needs its own slot — including the rollback journal a write transaction must
create:

```js
xOpen: if (pool.getFileCount() < pool.getCapacity()) { ...take a slot... }
       else toss("SAH pool is full. Cannot create file", path)
       catch (e) { return capi.SQLITE_CANTOPEN; }
```

So the first edit's `replica.enqueue` throws `SQLITE_CANTOPEN: sqlite3 result
code 14: unable to open database file`, and so does every edit after it —
nothing grows the pool. Reads are unaffected, so the pool is invisibly broken
until the user types.

That error message matches neither of the shapes pkm-c9hp taught the client
to recognise (`isSahPoolContention` matches only "access handle" /
"createSyncAccessHandle"), so `opQueue` fell through to `onDesync`, the
legacy authoritative repair adopted the edit-less server state, the active
outline was wiped, `textarea.block-input` detached, and Playwright sat on a
30 s timeout. c9hp's diagnosis was right; its whitelist was one error shape
short.

**Evidence.**

- Reproduced under load: three full e2e suites run concurrently on separate
  ports gave 2 failures in 12 suite runs (`assistant.spec.ts:17`,
  `ref-open.spec.ts:45`) — the same family as the bean's specs, so the flake
  is not confined to edit/paste. Plain CPU saturation alone (load average
  24 on 10 cores) did *not* reproduce it in 8 runs; concurrent browser work
  is the ingredient that matters.
- Instrumented build logged, in the failing run only:
  `openDb ok capacity= 1 files= 1` (every passing run: `capacity= 6`),
  followed by repeated `replica.enqueue failed: SQLITE_CANTOPEN … sah= false`.
- The captured `error-context.md` page snapshot at the moment of failure
  contains `Server rejected a change. Active outlines repaired.` — the
  c9hp banner, with the editor gone.
- Deterministic repro: forcing `reduceCapacity(5)` after the install (i.e.
  synthesising the observed capacity-1 state) failed **8/8** tests in
  `edit.spec.ts`, including the bean's `:124`, `:220` and `:308`. With the
  fix in place and the same forced reduction still applied, the worker logs
  `forced capacity= 1` → `restored capacity= 6` and the specs pass 11/11.

**Fix** (no timeouts were raised; no spec was touched):

- `web/src/replica/poolCapacity.ts` (new, unit-tested): `ensureMinimumCapacity`
  tops the pool up to `MIN_POOL_CAPACITY` (6, sqlite-wasm's own default), and
  `isPoolExhausted` recognises the `SQLITE_CANTOPEN` / "pool is full" surface.
- `web/src/replica/worker.ts`: `openDb` calls `ensureMinimumCapacity` between
  the install and the database open. `addCapacity` creates fresh
  randomly-named files, so it never contends with handles the outgoing worker
  still holds; a failure to grow propagates so the existing open retry can
  absorb transient contention and a persistent failure degrades the app to
  online-only rather than running on an unwritable replica.
- `web/src/sync/opQueue.ts`: an exhausted-pool enqueue failure now joins quota
  exhaustion and access-handle contention on the "cannot persist locally"
  path — direct POST, no `onDesync`, no outline wipe. Defence in depth: with
  the capacity fix this path should not be reached.
- `docs/architecture/sync-and-offline.md`: documents the second failure mode
  alongside the c9hp one, and flags that the classifier is a whitelist which
  must be extended, not worked around.

**Verification.**

- 36 consecutive full e2e suite runs (46 tests each) green under the load
  that reproduced the failure — 18 runs at 3-way suite concurrency, then 18
  more with 12 additional CPU hogs on top (load average ~23 on 10 cores).
  Pre-fix the same harness failed 2 of 12.
- New unit tests: 9 in `poolCapacity.test.ts`, plus a regression test in
  `opQueue.replica.test.ts` asserting SQLITE_CANTOPEN → direct post, no
  desync.
- `cd web && pnpm verify` green end to end: typecheck, eslint, fcis (132
  runtime modules, no boundary violations), 1714 unit tests across 115 files,
  coverage thresholds, bundle + precache budgets, 46 e2e.
- No `server/` changes.
