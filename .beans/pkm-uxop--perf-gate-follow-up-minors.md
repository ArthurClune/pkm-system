---
# pkm-uxop
title: Perf gate follow-up minors
status: completed
type: task
priority: low
created_at: 2026-09-26T14:18:16Z
updated_at: 2026-09-26T19:30:00Z
---

Minor findings from the perf-gate reviews (pkm-q1hh) that were judged real but not worth blocking merge. None affects today's counts.

## Orchestrator (server/tooling/perfcheck/run.py, run_core.py)
- [x] Fixture server runs in its own session; if run.py is SIGKILLed it keeps holding 8977. Add a SIGTERM→SystemExit handler or make e2e_serve exit when its parent dies; the port-busy message could suggest `lsof -iTCP:8977`.
- [x] `frontend_letters` silently drops a letter outside the context groups (a new scenario would always confirm as unstable).
- [x] Two runs in one worktree: result-frontend.json is unlinked before the lock and read after it (FileNotFoundError).
- [x] `--bootstrap` with `--rebaseline` silently runs `--rebaseline` (use a mutually exclusive group).
- [x] `_git` swallows git's stderr; `changed_paths` runs outside the handled region (raw traceback).
- [x] `changed_paths` uses `.split()`; paths with spaces break (use splitlines).

## Fixture (build.py, fixture.py)
- [x] build.py itself isn't part of the cache key.
- [x] fixture.py:155 dead first assignment of `g.popular`; fixture.py:231 `next()` raises StopIteration if the big page never nests. Editing fixture.py changes fixture_hash, so do this together with a planned re-bootstrap.

## Backend check (backend.py, sqlplan.py)
- [x] `test_writes_hit_a_fresh_copy` can't fail (`_Env` always copies).
- [x] Reads rely on every read scenario preceding every write in `scenarios()`; add a dirty flag.
- [x] `_Env.__init__` leaks its temp dir if `make_client` raises.
- [x] `sqlplan._ALIASED` drops the next alias after an unaliased table directly followed by JOIN (`FROM blocks JOIN pages p`); no current SQL has that shape.
- [x] `judge()` is public; three `# pyrefly: ignore` in test_perfcheck_compare.py could be assert-not-None narrowing.

## Frontend check (web/tooling/perf/check.mjs)
- [x] No guard that `__realNow` is the unfaked clock (init-script order is undefined); e.g. assert the K total isn't an integer.
- [x] `settle()` comment should state its assumption that follow-up requests start within its quiet window.
- [x] `pinSaveOrder`'s `pulled` latch fires on any pull, not only the save's; arm it inside the /api/ops handler.
- [x] Hand-rolled bag resets instead of harness `resetBag`; `--only` accepts unknown ids.
- [x] web/src/sync/replicaSync.test.ts: the performance.mark spy's mockRestore isn't in a finally.

Changes to check.mjs that alter counts need `perf/check.sh frontend --bootstrap`.

## Summary of Changes

**Orchestrator**
- run.py turns SIGTERM into SystemExit, so its cleanup runs.
- e2e_serve.py has a parent-pid watchdog, so an orphaned fixture server exits. The port-busy message suggests `lsof -iTCP:8977`.
- frontend_letters rejects unknown letters.
- result-frontend.json is unlinked and read under the same lock.
- --bootstrap and --rebaseline are mutually exclusive.
- _git surfaces git's stderr, and repo_root/changed_paths now run inside the handled region.
- changed_paths uses splitlines(), so paths with spaces work.

**Fixture**
- build.py's own source is part of the cache key.
- The dead g.popular assignment is gone.
- The big-page nesting lookup raises a clear error instead of StopIteration.
- The fixture hash changed, so both baselines were re-recorded.

**Backend check**
- A dirty flag makes a read scenario that runs after a write fail loudly.
- _Env removes its temp dir if make_client raises.
- sqlplan._ALIASED now handles `FROM t JOIN u x`.
- judge() is private, and the test's pyrefly ignores became assert-narrowing.
- test_writes_hit_a_fresh_copy now fails if writes accumulate.

**Frontend check**
- The assertRealNowUnfaked guard runs in drag().
- The settle() comment states its quiet-window assumption.
- pinSaveOrder's pulled latch is armed only after /api/ops is intercepted.
- resetBag replaces the hand-rolled bag resets, and --only rejects unknown letters.
- replicaSync.test.ts restores the mark spy in a finally.
