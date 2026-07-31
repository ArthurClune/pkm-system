---
# pkm-w80k
title: Keep CLI/MCP batch page creation inside the advertised atomic transaction
status: completed
type: bug
priority: high
created_at: 2026-07-31T15:54:48Z
updated_at: 2026-07-31T15:54:48Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 5.

**References:** server/src/pkm/cli/main.py:360-367,420-433; server/src/pkm/mcp/server.py:38-46,134-150; server/src/pkm/server/ops_core.py:75-95

Both shells call _ensure_page() before fully validating and posting a batch. A batch with a missing page followed by an invalid command can fail while leaving the page committed, contradicting the CLI/MCP "one atomic transaction" contract.

**Direction:** Validate the complete command batch before I/O. Represent missing pages as empty planning payloads and include supported create_page operations in the same OpBatch.

- [x] Add failed-batch tests asserting no pages or blocks remain
- [x] Move page creation into the atomic operation batch

## Summary of Changes

Both `pkm` and `pkm-mcp` called `_ensure_page()` (fetch, then `POST
/api/pages` on a 404) *before* planning/posting the batch of block ops.
A batch whose page didn't exist yet, followed by any later command that
failed to plan (bad command name, missing alias, etc.), left that empty
page committed even though the whole batch reported failure — the
"one atomic transaction" contract was only true for the blocks, not the
page.

Fix, applied identically to both CLI and MCP (all six call sites:
`cmd_save`/`cmd_upload`/`cmd_batch` in `cli/main.py`, `save_note`/
`upload_asset`/`batch` in `mcp/server.py`):

- `PkmClient.get_page_or_placeholder(title)` (new, `client/api.py`,
  Imperative Shell) replaces the duplicated `_ensure_page` in both
  shells. It fetches the page and returns `(payload, False)`, or on 404
  returns an empty placeholder `({"blocks": []}, True)` — it never
  creates anything itself.
- `create_page_ops(titles)` (new, `cli/build.py`, Functional Core, pure)
  turns titles that came back "missing" into `create_page` ops.
- Each write path now prepends `create_page_ops(...)` to the planned
  block ops and posts them as a single `OpBatch` via one `post_ops`
  call. `routes_ops.py` already rolls back the whole batch's transaction
  on any `OpError`, so a missing page's creation now shares that
  rollback instead of persisting from an earlier, separate request.

Removed `_ensure_page` from both `cli/main.py` and `mcp/server.py`
entirely (no more duplication). `PkmClient.create_page` (the direct
`POST /api/pages` wrapper) is left in place — it's still used directly
by test fixtures — but is no longer called from any write path's normal
flow.

**Tests (TDD):**
- RED: `tests/test_cli_main_write.py::test_save_empty_text_on_new_page_leaves_no_page_behind`
  and `test_batch_failure_after_new_page_leaves_no_page_or_blocks`, plus
  the MCP equivalents in `tests/test_mcp_server.py`, failed against the
  old code with "DID NOT RAISE ApiError" — i.e. the page was findable
  (created) after the overall operation reported failure, reproducing
  the bug exactly.
- Also added: `tests/test_cli_build.py::test_create_page_ops(_empty)` for
  the new pure planner, and `tests/test_client_api.py::test_get_page_or_placeholder_*`
  for the new client method (existing page passthrough; missing page
  returns a placeholder without creating it).
- GREEN: all of the above pass after the fix; existing tests
  (`test_save_creates_missing_page`, `test_batch_atomic_create_with_alias`,
  etc.) still pass unchanged, confirming successful creates/batches are
  unaffected.

**Full verification (from `server/`):**
- `uv run pytest -q` — 962 passed, coverage 96.13% (threshold 95%)
- `uv run pyrefly check` — 0 errors
- `uv run ruff check` — all checks passed

**Docs:** Added a paragraph to `docs/architecture/backend.md` under
"CLI and MCP server" documenting `get_page_or_placeholder` +
`create_page_ops` and why page creation now rides inside the batch.

**Self-review notes:** No behavior change for the common case (page
already exists, or a create succeeds) — verified by the unchanged
passing tests. One minor, intentional behavior change: a successful
`pkm batch`/`batch()` call against a genuinely new page now reports one
extra applied op (the `create_page`) in "applied N ops" — this is
correct/more truthful (that op really is applied) and no existing test
asserted a count for a new-page batch, since the shared `AI`/`Machine
Learning` seed pages already exist.
