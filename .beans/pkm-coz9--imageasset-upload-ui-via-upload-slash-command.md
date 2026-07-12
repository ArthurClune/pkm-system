---
# pkm-coz9
title: Image/asset upload UI via /upload slash command
status: completed
type: feature
priority: normal
created_at: 2026-07-11T20:42:45Z
updated_at: 2026-07-12T07:46:15Z
---

Need a UI for uploading images and other assets into the PKM. Trigger: an '/upload' slash command in the editor that opens a file picker, uploads the asset, and inserts a reference/embed at the cursor.

Checklist:
- [ ] Add '/upload' to the slash command menu
- [ ] File picker + upload to server (store asset, return URL/path)
- [ ] Insert markdown image embed (or link for non-image assets) at cursor
- [x] Serve uploaded assets from the backend

## Summary of Changes

The backend (POST /api/assets, GET /assets/{sha}/{name}) and the uploadAsset/assetMarkdown/onFiles helpers already existed. Added the frontend trigger: a `/upload` slash command whose pick strips the trigger and opens a hidden multi-file `<input type=file>`; chosen files go through the existing `onFiles` path, which uploads each and splices `![name](url)` (image) or `[name](url)` (other) at the caret. CSS hides the input (.upload-input).
