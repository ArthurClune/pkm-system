---
# pkm-jdu3
title: file browser UI for asset management
status: todo
type: feature
created_at: 2026-07-27T20:29:27Z
updated_at: 2026-07-27T20:29:27Z
parent: pkm-zx19
blocked_by:
    - pkm-zc0c
---

File browser for attachments, building on pkm-zc0c's description column and GET /api/assets/search seed endpoint.

- Search/filter by date, file type, and description text
- Single and multi-select
- Export selected to browser download
- Asset deletion UI with loud warning when the asset is linked in the db (link check = search blocks.text for the sha URL); remove links when removing attachments
- Orphan detection: list assets no longer linked in the db, with options to 1) delete or 2) copy link to clipboard for adding to a page
- Retro-scan button wired to POST /api/assets/scan; show per-asset description status (described/failed/pending) from pkm-zc0c
- Extend the list endpoint with date/type filters and pagination as needed
