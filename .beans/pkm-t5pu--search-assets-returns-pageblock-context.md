---
# pkm-t5pu
title: search_assets returns page/block context
status: todo
type: feature
created_at: 2026-07-28T10:37:46Z
updated_at: 2026-07-28T10:37:46Z
---

The assistant's search_assets MCP tool returns only asset metadata (sha256, filename, mime, size, url, description, status) — no page_title or block uid for blocks that reference the asset. The model therefore can only cite bare /assets/ URLs in replies (now clickable via pkm-gdi5) and cannot emit ((uid)) block refs or name the containing page.

Add referencing-block context server-side: for each hit in GET /api/assets/search, look up blocks whose text contains the sha (same FTS trick pkm-gdi5 uses client-side: FTS5 unicode61 keeps a 64-hex sha as one token, so an exact-match search on the sha finds referencing blocks). Surface page_title/uid through the AssetSearchPayload and render_assets so the assistant can link directly.

Notes:
- Touches AssetSearchPayload -> openapi.json + web/src/api/types.d.ts regeneration is mandatory.
- pkm-jdu3 (file browser) needs the same asset->block link check; build the lookup once, shared.
- While in policy.py: SYSTEM_PROMPT says 'ten PKM verbs' but lists eleven tools — fix the drift.
