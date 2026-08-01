---
# pkm-5k8p
title: Use canonical page titles returned by creation
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:03:12Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 22).

## Context

**References:** `server/src/pkm/cli/main.py:360-367`; `server/src/pkm/mcp/server.py:38-46`; `server/src/pkm/client/api.py:126-127`; `server/src/pkm/server/routes_pages.py:193-203`

Both _ensure_page() implementations ignore the canonical title returned by POST and refetch the original spelling. Leading/trailing or control whitespace can create the normalized page and then 404 on refetch, leaving side effects after a failed command.

Note: the high-priority sweep (pkm-w80k) removed _ensure_page from both shells and moved page creation into the OpBatch — verify what remains of this finding against current code before implementing; fix whatever canonical-title gap still exists.

**Direction:** Use the returned canonical title and centralize ensure-page behavior.

## Tasks

- [x] Add whitespace-normalization tests for CLI and MCP
- [x] Remove duplicate, non-canonical ensure-page implementations

## Summary of Changes

Verified against current code: `_ensure_page()` no longer exists anywhere
in `server/src/pkm/` (confirmed via grep) — pkm-w80k already removed both
copies and folded page creation into the atomic `OpBatch`. That part of
the original finding is obsolete; nothing to remove.

A live, narrower gap remained in the code that replaced it. Every op
within one `OpBatch` normalizes its own `page_title` independently
through `store.get_or_create_page`, so a batch that creates AND writes to
a page in the same call always lands on one canonical row regardless of
control whitespace in the title — that part was never broken. But
`PkmClient.get_page_or_placeholder` (the shared CLI/MCP "does this page
exist" check `cmd_save`/`cmd_upload`/`cmd_batch` and `save_note`/`batch`/
`upload_asset` all call first) looked up the caller's raw title verbatim.
A page whose title holds control whitespace (e.g. a stray tab) is only
ever stored, and addressable, under its normalized spelling
(`refs.normalize_title`, pkm-hjhy). So a SECOND write to the same
control-whitespace-titled page got a false "missing", fetched an empty
placeholder instead of the page's real blocks, and planned its new
content against that: fresh material landed at the top of the page
instead of being appended, and any `## Heading` parent the first write
had already created got minted a second time. Demonstrated end-to-end at
the CLI (`pkm save`) and MCP (`save_note`) layers with a real RED-then-
GREEN test showing exactly this (two "Notes" headings instead of one).

Fix: `get_page_or_placeholder` now looks up `normalize_title(title)`
instead of `title` verbatim — one line, in the single method both shells
already share, so this is the "centralize ensure-page behavior" the
brief asked for without inventing a new abstraction. The ops built
afterward still carry the caller's original, un-normalized title for
`page_title`; that's fine, since the server normalizes it again at the
same choke point and resolves to the identical row.

### Tests
- `server/tests/test_client_api.py::test_get_page_or_placeholder_finds_a_page_whose_title_holds_control_whitespace`
- `server/tests/test_cli_main_write.py::test_save_twice_to_a_control_whitespace_titled_page_appends_and_reuses_the_heading`
- `server/tests/test_mcp_server.py::test_save_note_twice_to_a_control_whitespace_titled_page_appends_and_reuses_the_heading`

All three confirmed RED against the pre-fix code (temporarily reverted,
reran, restored) before the one-line fix made them GREEN.

### Verification
- `cd server && uv run pytest -q` — 1034 passed, coverage 96.27%
- `cd server && uv run pyrefly check` — 0 errors
- `cd server && uv run ruff check` — all checks passed

### Files changed
- `server/src/pkm/client/api.py` — `get_page_or_placeholder` normalizes
  the lookup title
- `server/tests/test_client_api.py`, `server/tests/test_cli_main_write.py`,
  `server/tests/test_mcp_server.py` — regression tests
- `docs/architecture/backend.md` — extended the existing
  `get_page_or_placeholder`/OpBatch bullet with this normalization note

No HTTP route, query param, or response field changed, so no OpenAPI/
gen-types regen was needed.
