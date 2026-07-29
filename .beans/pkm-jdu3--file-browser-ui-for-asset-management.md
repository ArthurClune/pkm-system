---
# pkm-jdu3
title: file browser UI for asset management
status: completed
type: feature
priority: normal
created_at: 2026-07-27T20:29:27Z
updated_at: 2026-07-29T13:54:27Z
parent: pkm-zx19
blocked_by:
    - pkm-zc0c
---

File browser for attachments, building on pkm-zc0c's description column and GET /api/assets/search seed endpoint.

Design spec (2026-07-29): docs/superpowers/specs/2026-07-29-asset-file-browser-design.md

- Search/filter by date, file type, and description text
- Single and multi-select
- Export selected to browser download
- Asset deletion UI with loud warning when the asset is linked in the db (link check = search blocks.text for the sha URL); remove links when removing attachments
- Orphan detection: list assets no longer linked in the db, with options to 1) delete or 2) copy link to clipboard for adding to a page
- Retro-scan button wired to POST /api/assets/scan; show per-asset description status (described/failed/pending) from pkm-zc0c
- Extend the list endpoint with date/type filters and pagination as needed

## Carry-over from pkm-t5pu final review (2026-07-28)

- Reuse `referencing_blocks(db, sha256)` in `server/src/pkm/server/routes_assets.py` for the delete-warning / orphan checks; while adding the second caller, tighten its return type to `list[dict[str, str]]`.
- Strengthen `test_render_assets_tolerates_missing_refs_key` with `assert "in [[" not in out`.
- Optional: end-to-end test that deleting a referencing block drops it from `refs` (pins the FTS delete trigger user-visibly).
- Note: `/api/assets/search` computes refs per hit even for the `q=""` recency listing — if the browser's page size grows large, that's where an `include_refs` flag would go.
- The search payload's `refs` field already answers linked-vs-orphan client-side for list views (`refs` non-empty = linked); the "link check = search blocks.text" bullet above predates pkm-t5pu and is superseded.

## Implementation Tasks (plan: docs/superpowers/plans/2026-07-29-asset-file-browser.md)

- [x] Task 1: Server functional core — assets_core.py
- [x] Task 2: Extend GET /api/assets/search — filters, pagination, total
- [x] Task 3: DELETE /api/assets/{sha256}
- [x] Task 4: POST /api/assets/export.zip
- [x] Task 5: Web functional core — types + filesCore.ts
- [x] Task 6: The Files view, route, nav, styles
- [x] Task 7: End-to-end test
- [x] Task 8: Final verification, bean close-out, integration

## Summary of Changes

Implemented via plan docs/superpowers/plans/2026-07-29-asset-file-browser.md on branch worktree-pkm-jdu3-file-browser (subagent-driven development, per-task + final whole-branch review).

**Server** (`routes_assets.py`, new `assets_core.py` functional core):
- Extended `GET /api/assets/search`: `type` (image/pdf/document/other), `from_ms`/`to_ms` (inclusive, NULL created_at excluded), `linked` (all/linked/orphan), `offset` pagination, `total` count, and `describe_error` on each item (failed badge hover). linked/orphan path scans the filtered set then paginates (personal scale).
- New `DELETE /api/assets/{sha256}`: strips image/link/pdf-macro/bare-URL reference tokens from block text via `strip_asset_tokens`, deletes emptied leaf blocks (explicit per-uid DELETE for the FTS trigger; emptied parents kept), removes the assets row, commits, then best-effort unlinks the disk file; nudges sync after commit. Returns `{deleted, refs_removed}`.
- New `POST /api/assets/export.zip`: form-encoded repeated `sha256s`, in-RAM zip, `assets-YYYY-MM-DD.zip` attachment; unknown/malformed/duplicate/missing-on-disk shas skipped; filenames pass through `safe_filename` (legacy unsafe rows) before `zip_arcnames` collision dedupe.
- openapi.json + types.d.ts regenerated with each route change.

**Web**:
- `views/filesCore.ts` (FC): filters→querystring (local-day date bounds), mimeCategory (mirrors server), clipboardToken, calm/loud deleteConfirm text, summarizeDeletes, formatSize.
- `views/Files.tsx` (IS) at `/files` + nav link above Settings: thumbnail grid, search/type/date/linked filters (250ms debounce, stale-response guard), select-all-across-pages, per-item delete loop with failure summary, orphan copy-link, scan button (queued count / disabled reason), hidden-form export, broken-image fallback, load-more. `.files-*` styles reuse existing tokens; `.confirm-dialog-message` gained `white-space: pre-line` so the loud multi-line warning renders as lines.
- e2e `web/e2e/files.spec.ts`: browse, orphan copy-link + purge, loud linked delete (token stripped server-side, asserted via waitForServerText), export download filename.

**pkm-t5pu carry-overs landed**: `referencing_blocks` return type tightened to `list[dict[str, str]]`; `test_render_assets_tolerates_missing_refs_key` asserts `\"in [[\" not in out`; `test_deleted_block_drops_out_of_fts_refs` pins the FTS delete trigger user-visibly.

**Verification**: server 897 passed, coverage 95.91% (gate 95), pyrefly 0 errors, ruff clean; web pnpm verify green (typecheck, lint, fcis, coverage 97/92/94/97 vs 95/91/89/95, build, 46 e2e incl. 2 new files specs).

## Deferred follow-up notes (from final review, all non-blocking)

- Orphan-filter Select all compounds the accepted full-scan: ~(N/50)×N ref lookups; if it ever feels slow, push the linked filter into SQL (EXISTS against FTS) or add a sha-only select-all endpoint (pairs with the earlier include_refs note above).
- `aria-live=\"polite\"` on the Files notice line would announce batch results to screen readers.
- Offset pagination can skip/dup an item if a delete lands between Load more pages (self-heals on reload).
- Files.tsx selectAll page-walk has no stale-filter generation guard (busy gating makes it a cosmetic race).
