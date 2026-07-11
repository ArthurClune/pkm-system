---
# pkm-coz9
title: Image/asset upload UI via /upload slash command
status: todo
type: feature
created_at: 2026-07-11T20:42:45Z
updated_at: 2026-07-11T20:42:45Z
---

Need a UI for uploading images and other assets into the PKM. Trigger: an '/upload' slash command in the editor that opens a file picker, uploads the asset, and inserts a reference/embed at the cursor.

Checklist:
- [ ] Add '/upload' to the slash command menu
- [ ] File picker + upload to server (store asset, return URL/path)
- [ ] Insert markdown image embed (or link for non-image assets) at cursor
- [ ] Serve uploaded assets from the backend
