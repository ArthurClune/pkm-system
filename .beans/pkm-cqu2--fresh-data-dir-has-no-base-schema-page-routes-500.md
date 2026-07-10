---
# pkm-cqu2
title: 'Fresh data dir has no base schema: page routes 500 with ''no such table: pages'''
status: completed
type: bug
priority: normal
created_at: 2026-07-10T13:02:39Z
updated_at: 2026-07-10T13:10:13Z
---

Following the README setup path (pkm.server.setup then pkm.server.run with a brand-new data dir, no Roam import) produces a broken app: every page route 500s with sqlite3.OperationalError: no such table: pages (seen from routes_pages.get_journal -> store.fetch_page).

Root cause: create_app() calls init_db() (added in pkm-2939), but init_db only sets WAL mode and runs incremental IF-NOT-EXISTS migrations -- the base schema (pages, blocks, etc.) is only ever created by the importer's fresh-database build. So a new install without an import has no tables.

Fix direction: init_db (or setup) should create the full base schema idempotently so an empty PKM works out of the box; the importer's schema-creation code is presumably the source of truth to share/reuse.

Found 2026-07-10 while verifying pkm-2gn2 against a scratch data dir.

## Summary of Changes

Confirmed root cause: `server/src/pkm/schema.py`'s `DDL` (pages, blocks,
refs, assets, FTS5 tables/triggers) used plain `CREATE TABLE`/`CREATE
INDEX`/`CREATE VIRTUAL TABLE`/`CREATE TRIGGER` statements, only ever run
by the importer (`importer/run.py`) against a brand-new sqlite file.
`init_db()` (server/db.py) only ran `SIDEBAR_ENTRIES_DDL` (already
`IF NOT EXISTS`), so a data dir created via `pkm.server.setup` +
`pkm.server.run` with no Roam import had zero tables and every page
route 500'd. The test suite didn't catch this because `tests/conftest.py`'s
`seeded_config` fixture separately ran `con.executescript(DDL)` after
`init_db()`, masking the gap.

Fix: made every statement in `schema.DDL` idempotent (`IF NOT EXISTS` on
all `CREATE TABLE`/`CREATE INDEX`/`CREATE VIRTUAL TABLE`/`CREATE TRIGGER`
statements -- verified SQLite supports `IF NOT EXISTS` on all four), then
changed `init_db()` to execute the full `DDL` (which already includes
`SIDEBAR_ENTRIES_DDL`) instead of `SIDEBAR_ENTRIES_DDL` alone. `schema.DDL`
is now the single source of truth for the base schema: the importer
builds a fresh file with it as before, and `init_db()` applies the same
script idempotently at every process startup, so an empty data dir gets a
working schema and an already-populated database is a no-op re-run.
Removed the now-redundant manual `executescript(DDL)` from the
`seeded_config` test fixture and tightened stale "WAL + migrations"
comments in `app.py`/`run.py`/`conftest.py` to describe what `init_db()`
now actually does.

Files changed:
- `server/src/pkm/schema.py` -- `IF NOT EXISTS` on all DDL statements;
  updated module/`SIDEBAR_ENTRIES_DDL` docstrings/comments
- `server/src/pkm/server/db.py` -- `init_db()` runs `DDL` instead of
  `SIDEBAR_ENTRIES_DDL`; updated docstring
- `server/src/pkm/server/app.py` -- comment update
- `server/src/pkm/server/run.py` -- comment update
- `server/tests/conftest.py` -- removed redundant `executescript(DDL)`
  call and unused import; comment update
- `server/tests/test_server_scaffold.py` -- new regression test
  `test_fresh_data_dir_serves_journal_without_an_import`: builds
  `create_app()` against a brand-new `tmp_path` (no prior schema), logs
  in, and asserts `GET /api/journal` returns 200 instead of 500. Fails
  against the pre-fix code with `sqlite3.OperationalError: no such
  table: pages`.

Verification:
- `cd server && uv run pytest -q` -- 281 passed
- `cd server && uv run pyrefly check src tests` -- 0 errors (2 suppressed)
- `cd server && uv run ruff check` -- all checks passed
- Manual end-to-end: ran `python -m pkm.server.setup --data-dir
  /tmp/pkm-cqu2-e2e --password ... --insecure-cookie` then `python -m
  pkm.server.run --data-dir /tmp/pkm-cqu2-e2e --port 18974` against a
  brand-new dir, logged in via `/api/login`, and `GET /api/journal`
  returned 200 with a real journal payload (previously 500'd per the bug
  report).
