---
# pkm-13ty
title: Bound memory use for ZIP responses
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T09:09:54Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 26).

## Context

**References:** `server/src/pkm/server/routes_export.py:155-168`; `server/src/pkm/server/routes_assets.py:202-228`

Whole-graph and selected-asset exports build complete ZIPs in BytesIO and call getvalue(). Selected assets have no count or total-byte bound, so a large request can exhaust the process.

**Direction:** Use a temporary-file-backed or streaming response and enforce count/byte limits.

## Tasks

- [x] Add archive size/count limit tests
- [x] Verify temporary archive cleanup on cancellation/error
- [x] Replace unbounded in-memory buffering

## Summary of Changes

Both ZIP-building routes now stream from a temp-file-backed archive
instead of an in-memory `BytesIO`, and the selected-asset export gained a
hard count/byte cap enforced before the archive is built.

- **`server/src/pkm/assets_core.py`**: new pure `export_limit_violation(count,
  total_bytes, *, max_count, max_bytes) -> str | None` — the count check
  runs first (cheaper for a user to act on), returns a 413-ready detail
  string naming the exceeded limit and the actual value, or `None` if both
  are within bounds.
- **`server/src/pkm/server/tempfile_response.py`** (new, Imperative Shell):
  `CleanupFileResponse`, a `FileResponse` subclass whose `cleanup`
  coroutine runs unconditionally — success, a send-time exception (client
  disconnect mid-download), or a missing file — wrapped in `try/finally`.
  Stock Starlette `FileResponse.background` is only awaited *after* a send
  loop that returns without raising, so it alone cannot guarantee cleanup
  on an interrupted transfer; verified this gap directly by reading
  `starlette.responses.FileResponse.__call__` (installed 1.3.1) before
  writing the fix.
- **`server/src/pkm/server/routes_assets.py`**: `export_assets` now (a)
  sums `size` from the `assets` table for every selected, on-disk asset
  *before* building anything, refusing with 413 via
  `export_limit_violation` against new `MAX_EXPORT_ASSET_COUNT` (500) /
  `MAX_EXPORT_TOTAL_BYTES` (1 GiB) constants if either is exceeded — no
  file is opened just to measure the total; (b) builds the zip into a
  `tempfile.mkdtemp()`-backed directory and returns it via
  `CleanupFileResponse`, with an explicit `except Exception: rmtree; raise`
  around the build step for failures that happen before the response
  object even exists.
- **`server/src/pkm/server/routes_export.py`**: `export_all_markdown` gets
  the identical temp-dir + `CleanupFileResponse` treatment (no count/byte
  limit here — the whole graph has no user-controlled selection to bound).
- **Docs**: `docs/architecture/backend.md` — added `tempfile_response.py`
  to the module table, replaced the stale "builds in RAM, bounded by the
  user's selection" line under Assets with the new limit/temp-file
  behaviour.
- **Regen**: `openapi.json` + `web/src/api/types.d.ts` regenerated (the
  return-type annotation changed from `Response` to `FileResponse` on both
  routes, but the diff is docstring-only — no schema/contract change).
  Verified `web/src/views/Files.tsx`'s plain `<form method="post">` submit
  to `/api/assets/export.zip` still typechecks and its unit tests still
  pass; the route's request/response shape is unchanged.

Tests added: `test_assets_core.py` (5 cases for
`export_limit_violation`), `test_tempfile_response.py` (3 cases proving
`CleanupFileResponse` cleans up on success, on a send-time exception, and
on a missing file), `test_asset_export.py` (6 cases: over-count 413,
at-limit success, over-bytes 413, over-limit-never-partial, temp-dir-used
+ removed-after-success, temp-dir-removed-on-build-error),
`test_export_routes.py` (2 cases: temp-dir-used + removed-after-success,
temp-dir-removed-on-build-error for the whole-graph route). All written
RED-first against the pre-change code/absent module, then made GREEN.

Full suite: `cd server && uv run pytest -q` → 1069 passed, coverage
96.34% (required 95%). `uv run pyrefly check` → 0 errors. `uv run ruff
check` → all checks passed. `cd web && pnpm typecheck` and `pnpm
test:unit` → clean (1750 tests passed); full `pnpm verify` (Playwright
e2e) not run since no web source file changed, only generated
`openapi.json`/`types.d.ts`.

### Fix Round 1 (review finding)

Review flagged that the stated rationale for `CleanupFileResponse` was
wrong for this project's actual ASGI server: uvicorn's `send()`
(verified directly against the installed 0.49.0's `h11_impl.py`)
silently no-ops on a dropped connection rather than raising, so a real
client disconnect does *not* skip stock `FileResponse.background` —
that gap only matters for a missing/unreadable file at send time, or
defense-in-depth against a non-uvicorn ASGI server whose `send()` does
raise on disconnect. Fixed the rationale in
`server/src/pkm/server/tempfile_response.py`'s docstring,
`docs/architecture/backend.md`'s Assets section and module table, and
this report's own claims; renamed the synthetic
`test_cleanup_runs_even_if_send_raises_mid_transfer` test to
`test_cleanup_runs_if_send_itself_raises_mid_transfer` with a comment
stating it's not a model of uvicorn's actual behavior. No production
code changed (the reviewer's instruction: don't touch the response
class itself). Re-ran `tests/test_tempfile_response.py` (3 passed) and
the full suite (1069 passed, 96.34% coverage; pyrefly 0 errors; ruff
clean).
