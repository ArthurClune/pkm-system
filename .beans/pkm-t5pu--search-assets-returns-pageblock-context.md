---
# pkm-t5pu
title: search_assets returns page/block context
status: completed
type: feature
priority: normal
created_at: 2026-07-28T10:37:46Z
updated_at: 2026-07-28T18:37:07Z
---

The assistant's search_assets MCP tool returns only asset metadata (sha256, filename, mime, size, url, description, status) — no page_title or block uid for blocks that reference the asset. The model therefore can only cite bare /assets/ URLs in replies (now clickable via pkm-gdi5) and cannot emit ((uid)) block refs or name the containing page.

Add referencing-block context server-side: for each hit in GET /api/assets/search, look up blocks whose text contains the sha (same FTS trick pkm-gdi5 uses client-side: FTS5 unicode61 keeps a 64-hex sha as one token, so an exact-match search on the sha finds referencing blocks). Surface page_title/uid through the AssetSearchPayload and render_assets so the assistant can link directly.

Notes:
- Touches AssetSearchPayload -> openapi.json + web/src/api/types.d.ts regeneration is mandatory.
- pkm-jdu3 (file browser) needs the same asset->block link check; build the lookup once, shared.
- While in policy.py: SYSTEM_PROMPT says 'ten PKM verbs' but lists eleven tools — fix the drift.

## Note (2026-07-28, after pkm-hjcc)

pkm-hjcc's live smoke showed the model already finds ((uid))s and page titles on its own via get_page after search_assets — first-pass answers now carry clickable asset URLs + ((uid)) refs without this bean. So this is an efficiency win (fewer tool round-trips, direct citation from one search_assets call), not a capability gap. Priority accordingly.

## Summary of Changes

### Task 1: server refs helper + payload + regen (COMPLETED)
- Added `get_referencing_blocks(sha256)` helper to `/api/assets/search` route (route_assets.py)
- Extended AssetSearchPayload/AssetSearchItem to include `refs: list[{uid, page_title}]`
- Regenerated openapi.json and web types

### Task 2: render + docstring (COMPLETED)
- Extended `render_assets()` in cli/render.py to output ref lines as `  in [[page_title]] ((uid))` after description
- Used defensive `a.get("refs")` to support older servers lacking the field
- Updated render_assets docstring to document refs output
- Updated search_assets MCP tool docstring to teach the assistant about inline refs + cite guidance
- Tests: extended test_render_assets with refs payload and assertions; added test_render_assets_tolerates_missing_refs_key for backward compatibility
- Verification: all 829 tests pass, pyrefly clean, ruff clean, coverage 95.89%

### Note on "ten PKM verbs" drift
Verified with `grep -n "ten" server/src/pkm/assistant/policy.py`: no match. The drift mentioned in the bean was already fixed by pkm-hjcc.
