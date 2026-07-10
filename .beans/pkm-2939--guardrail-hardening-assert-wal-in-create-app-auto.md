---
# pkm-2939
title: 'Guardrail hardening: assert WAL in create_app; auto-discover read routes in drift test'
status: completed
type: task
priority: normal
created_at: 2026-07-10T12:21:55Z
updated_at: 2026-07-10T12:38:03Z
---

Follow-ups from the 2026-07-10 batch final-review triage — two convention-only guarantees worth making structural: (1) init_db()-before-serve is by convention; a future entrypoint or direct create_app(config) that serves DB routes would silently run non-WAL/non-migrated. Add a cheap assertion in create_app (e.g. journal_mode == 'wal' on a probe connection, or call init_db there) so it is un-forgettable; reconcile with the 7 TestClient call sites that don't use the with-form. (2) server/tests/test_openapi_sync.py's test_read_routes_declare_response_models hardcodes the 8 route→model pairs; auto-discover GET routes from the OpenAPI document instead so a new read route returning a bare dict fails the test.

## Checklist
- [x] WAL/init assertion in create_app (or init_db call) + test
- [x] Drift test auto-discovers read routes instead of hardcoded map
- [x] Suites green



## Summary of Changes

**WAL/init guardrail — chose option (b) "create_app calls init_db itself":**
`create_app()` (server/src/pkm/server/app.py) now calls `init_db(config.db_path)` as
its first line. `init_db()` is already documented as idempotent and cheap (one
`PRAGMA journal_mode=WAL` plus an `IF NOT EXISTS` migration), so making it
un-forgettable this way needed no new locking/probe logic and kept every
existing call site working:
- The 7 `TestClient(create_app(...))` sites (conftest.py, test_asset_upload.py,
  test_server_scaffold.py x1, test_spa.py x4) all pass `tmp_path`-based db
  paths whose parent directory exists, so the extra init_db() call is a no-op
  cost and, for the 5 sites that never called init_db() explicitly, is now a
  correctness improvement (WAL + sidebar_entries migration applied where it
  previously wasn't).
- `run.py`'s explicit `init_db(config.db_path)` call before `create_app(config)`
  became redundant and was removed (comment updated to explain create_app now
  owns it), so init_db no longer needs to be remembered by any entrypoint.
- Two direct `create_app(config)` call sites used a deliberately
  *nonexistent* db path (`openapi_dump.py`'s CLI script and
  `test_openapi_sync.py`'s `_dummy_config()`) to document "touches no
  database." Since `sqlite3.connect()` raises immediately when the parent
  directory doesn't exist, an unconditional init_db() call broke that
  pattern — both were switched to a scratch `tempfile` directory instead
  (still no real/production database touched, just a throwaway file).

Considered probing `journal_mode` via a lightweight side connection instead of
calling init_db(), but that would have needed its own idempotent
schema-migration path to also stay correct, duplicating init_db() rather than
reusing it — calling init_db() directly was simpler and matched the existing
"idempotent, cheap, un-forgettable" framing in the bean.

**Drift test auto-discovery:**
`test_openapi_sync.py` no longer hardcodes an 8-entry `path -> model name`
map. It now calls `create_app(...).openapi()`, walks every `GET` route via
`_get_routes()`, and for each one not in the small explicit
`EXEMPT_READ_ROUTES` set (`/healthz`, `/api/openapi.json`,
`/assets/{sha256}/{filename}` — health check, schema introspection, and a
binary file download, none of which are JSON API payloads) asserts its 200
`application/json` schema is a named `$ref` component rather than a bare/
untyped dict. A new meta-test
(`test_undeclared_response_model_checker_catches_a_bare_dict_route`) builds a
throwaway FastAPI app with a `-> dict` GET route and asserts the checker
flags it, proving a future bare-dict read route would fail
`test_read_routes_declare_response_models`.

**Verification:**
- `cd server && uv run pytest -q` → 278 passed
- `cd server && uv run ruff check` → all checks passed
- `uv run --project server pyrefly check` → 0 errors (had to route around a
  worktree-path quirk: this session's `.claude/worktrees/...` path has a
  dot-prefixed ancestor directory that made pyrefly's default project-include
  glob resolve to zero files; passing the changed files explicitly with
  `--python-interpreter-path server/.venv/bin/python --search-path server/src`
  reported 0 errors. Confirmed this is pre-existing/environment-only by
  reproducing the same glob-vs-dot-directory behavior difference between the
  main checkout and this worktree, unrelated to this change.)
- `uv run --project server pyright` → 1 pre-existing, unrelated error in
  `server/tests/e2e_serve.py:48` (`uvicorn.config` attribute access), present
  identically on `main` before this branch.
- No web/ files touched, so web suites weren't run.
