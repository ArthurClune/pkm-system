---
# pkm-c17m
title: Avoid orphan assets in upload-and-link workflows
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:35:13Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 24).

## Context

**References:** `server/src/pkm/cli/main.py:405-416`; `server/src/pkm/mcp/server.py:153-168`; `server/src/pkm/client/api.py:135-142`

The asset is uploaded before page/parent validation and before the block operation. Invalid parents or failed operations leave unlinked assets; CLI prints the URL before linking succeeds.

**Direction:** Resolve/validate destination before upload, delay success output, and add either a transactional endpoint or compensating deletion for post-upload write failure.

## Tasks

- [x] Add invalid-parent and post-upload operation-failure tests
- [x] Prevent or compensate orphaned uploads

## Summary of Changes

`pkm upload` (CLI) and `upload_asset` (MCP) now resolve/validate the
destination page and parent **before** touching `/api/assets`, and delay
all success output until the follow-up `/api/ops` link write actually
lands:

- `cli/main.py::cmd_upload` and `mcp/server.py::upload_asset` fetch the
  page and call `resolve_parent(payload, parent)` first — an invalid
  `((uid))` parent now raises `BuildError` with no upload ever attempted.
  The CLI no longer prints the asset URL until after `post_ops` succeeds.
- `POST /api/assets` (`routes_assets.py`) now returns an `existing: bool`
  field on `AssetUploadResponse`, recording whether the `sha256` row was
  already present before this call (a content-address dedup hit) or is
  brand new. This is the load-bearing distinction for compensation: an
  already-existing asset may already be referenced elsewhere, so deleting
  it on a later failure would destroy real content, not an orphan.
- `PkmClient.delete_asset` (new) wraps `DELETE /api/assets/{sha256}`.
  Both `cmd_upload` and `upload_asset` now catch `ApiError` from
  `post_ops`; if `asset["existing"]` is `False` they call
  `client.delete_asset(...)` to remove the orphan before re-raising.
- Regenerated `web/src/api/openapi.json` + `types.d.ts` for the new
  response field; fixed two web test fixtures
  (`sync/assets.test.ts`, `sync/connectionAware.test.tsx`) that
  constructed full `AssetUploadResponse` literals. Added
  `docs/architecture/backend.md` prose under **Assets** documenting the
  `existing` field and the compensation invariant.

**Tests (TDD, RED before GREEN):**
- `server/tests/test_cli_main_write.py`: `test_upload_invalid_parent_is_rejected_before_any_upload`,
  `test_upload_post_ops_failure_deletes_the_orphaned_asset`,
  `test_upload_post_ops_failure_does_not_delete_a_pre_existing_asset`.
- `server/tests/test_mcp_server.py`: matching `test_upload_asset_*` trio.
- `server/tests/test_asset_upload.py`: `test_upload_roundtrip` updated for
  the new field; added
  `test_upload_existing_flag_distinguishes_new_from_deduped_uploads`.

**Verification:** `cd server && uv run pytest -q` (1047 passed, 96.25%
coverage), `uv run pyrefly check` (0 errors), `uv run ruff check` (clean);
`cd web && pnpm typecheck` and `pnpm test:unit` (115 files / 1750 tests)
both clean after the fixture fixes.
