---
# pkm-tub8
title: Uploaded files each go on their own bullet
status: completed
type: feature
priority: normal
created_at: 2026-10-23T08:25:33Z
updated_at: 2026-10-23T08:58:36Z
---

Uploading via /upload, paste, or a drop onto an editing block splices every asset link into the current block, space-joined. Instead each upload becomes its own sibling block after the current one; if the current block is empty the first upload fills it. Applies to a single upload too.

- [x] Design doc
- [x] Plan
- [x] Pure planner + tests
- [x] Wire onFiles
- [x] E2E
- [x] Docs

## Summary of Changes

- `planUploadBlocks` (web/src/outline/fileDrop.ts) plans one block per upload; `useOutline.handlers.onFiles` uses it, so `/upload`, paste and a drop onto an editing block each give every file its own sibling bullet, and an empty block takes the first.
- `web/e2e/upload-bullets.spec.ts` covers `/upload` with two images and a paste into an empty block.
- Docs: `frontend-editor.md` Files-drag table and `keyboard.md` `/upload` row updated.
