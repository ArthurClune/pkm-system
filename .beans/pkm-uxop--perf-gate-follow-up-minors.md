---
# pkm-uxop
title: Perf gate follow-up minors
status: todo
type: task
priority: low
created_at: 2026-09-26T14:18:16Z
updated_at: 2026-09-26T14:18:16Z
---

Minor findings from the perf-gate reviews (pkm-q1hh) that were judged real but not worth blocking merge. None affects today's counts.

## Orchestrator (server/tooling/perfcheck/run.py, run_core.py)
- [ ] Fixture server runs in its own session; if run.py is SIGKILLed it keeps holding 8977. Add a SIGTERM→SystemExit handler or make e2e_serve exit when its parent dies; the port-busy message could suggest `lsof -iTCP:8977`.
- [ ] `frontend_letters` silently drops a letter outside the context groups (a new scenario would always confirm as unstable).
- [ ] Two runs in one worktree: result-frontend.json is unlinked before the lock and read after it (FileNotFoundError).
- [ ] `--bootstrap` with `--rebaseline` silently runs `--rebaseline` (use a mutually exclusive group).
- [ ] `_git` swallows git's stderr; `changed_paths` runs outside the handled region (raw traceback).
- [ ] `changed_paths` uses `.split()`; paths with spaces break (use splitlines).

## Fixture (build.py, fixture.py)
- [ ] build.py itself isn't part of the cache key.
- [ ] fixture.py:155 dead first assignment of `g.popular`; fixture.py:231 `next()` raises StopIteration if the big page never nests. Editing fixture.py changes fixture_hash, so do this together with a planned re-bootstrap.

## Backend check (backend.py, sqlplan.py)
- [ ] `test_writes_hit_a_fresh_copy` can't fail (`_Env` always copies).
- [ ] Reads rely on every read scenario preceding every write in `scenarios()`; add a dirty flag.
- [ ] `_Env.__init__` leaks its temp dir if `make_client` raises.
- [ ] `sqlplan._ALIASED` drops the next alias after an unaliased table directly followed by JOIN (`FROM blocks JOIN pages p`); no current SQL has that shape.
- [ ] `judge()` is public; three `# pyrefly: ignore` in test_perfcheck_compare.py could be assert-not-None narrowing.

## Frontend check (web/tooling/perf/check.mjs)
- [ ] No guard that `__realNow` is the unfaked clock (init-script order is undefined); e.g. assert the K total isn't an integer.
- [ ] `settle()` comment should state its assumption that follow-up requests start within its quiet window.
- [ ] `pinSaveOrder`'s `pulled` latch fires on any pull, not only the save's; arm it inside the /api/ops handler.
- [ ] Hand-rolled bag resets instead of harness `resetBag`; `--only` accepts unknown ids.
- [ ] web/src/sync/replicaSync.test.ts: the performance.mark spy's mockRestore isn't in a finally.

Changes to check.mjs that alter counts need `perf/check.sh frontend --bootstrap`.
