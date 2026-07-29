---
# pkm-jdu3
title: file browser UI for asset management
status: in-progress
type: feature
priority: normal
created_at: 2026-07-27T20:29:27Z
updated_at: 2026-07-29T13:23:05Z
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
- [ ] Task 6: The Files view, route, nav, styles
- [ ] Task 7: End-to-end test
- [ ] Task 8: Final verification, bean close-out, integration
