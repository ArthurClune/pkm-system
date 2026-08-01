---
# pkm-3cyg
title: Do not silently truncate CLI/MCP backlinks
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:15:06Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 23).

## Context

**References:** `server/src/pkm/client/api.py:102-105`; `server/src/pkm/cli/main.py:78-81,335-339`; `server/src/pkm/mcp/server.py:80-84`; `server/src/pkm/server/routes_pages.py:165-187`

get_page() requests at most 100 backlink groups while the route is paginated. CLI/MCP render the partial result without a truncation marker despite CLI wording that promises every block.

**Direction:** Fetch all pages or expose pagination and clearly report truncation through a dedicated client method. (Arthur's standing preference: no silent truncation.)

## Tasks

- [x] Test total_pages > len(groups) in client, CLI, and MCP
- [x] Make completeness/truncation explicit

## Summary of Changes

Added `PkmClient.get_backlinks(title, page_size=100)` (`server/src/pkm/client/api.py`),
which loops `GET /api/page`'s `bl_offset`/`bl_limit` pagination until every
backlink group has been fetched, instead of the old single `get_page()`
call that silently dropped anything past the route's 100-group cap.
`get_page()` gained an explicit `bl_offset` parameter so the loop can
request each page.

`cmd_refs` (CLI `pkm refs`, `server/src/pkm/cli/main.py`) and the MCP
`backlinks` tool (`server/src/pkm/mcp/server.py`) now call
`get_backlinks()` instead of `get_page()`, so both always render the
complete backlink list the CLI's own help text already promised.
`get_page()` itself (page content reads) is unchanged and still returns
only one page of backlinks alongside the blocks -- it isn't used for
backlink-only display.

Added a `seed_backlinks` factory fixture (`server/tests/conftest.py`)
that inserts N extra pages/blocks/refs pointing at "Machine Learning",
used to push `total_pages` past the route's single-request cap in new
tests covering the client, CLI, and MCP:
- `test_get_backlinks_fetches_every_group_beyond_the_single_page_cap`
  and `test_get_backlinks_no_backlinks_makes_one_request`
  (`server/tests/test_client_api.py`)
- `test_refs_returns_every_group_beyond_the_single_page_cap`
  (`server/tests/test_cli_main_read.py`)
- `test_backlinks_returns_every_group_beyond_the_single_page_cap`
  (`server/tests/test_mcp_server.py`)

Documented the mechanism in `docs/architecture/backend.md` (new bullet
next to the MCP tools list) since it's a non-obvious invariant: which
client method loops pagination and why.

Verification: `uv run pytest -q` (1038 passed, 96.28% coverage),
`uv run pyrefly check` (0 errors), `uv run ruff check` (all checks
passed) -- all from the worktree's `server/`.
