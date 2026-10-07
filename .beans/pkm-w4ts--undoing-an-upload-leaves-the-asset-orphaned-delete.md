---
# pkm-w4ts
title: 'Undoing an upload leaves the asset orphaned: delete it once redo is gone'
status: completed
type: bug
priority: normal
created_at: 2026-10-07T19:51:52Z
updated_at: 2026-10-07T21:05:08Z
---

Undoing an upload leaves the uploaded asset orphaned in the store. Applies to every upload path that edits the outline: /upload, paste, file drop onto the focused textarea, and file drag-and-drop onto the page (pkm-qkoq). Reported by Arthur during pkm-qkoq's manual check.

Want: Cmd-Z on an upload also deletes the file when that was its last reference.

Agreed so far (2026-10-07), to be refined in brainstorming before implementation:

- **Timing: delete when redo is gone**, not on undo itself, so redo stays instant and offline-safe. Moments redo is gone: the next edit clears the redo stack (`outline/history.ts` record), the entry ages out (HISTORY_CAP), leaving the page, closing the tab (keepalive fetch / pagehide).
- **Only assets this upload created**: the upload response's `existing: false`. A dedup hit is never deleted, even if unreferenced; it may be a deliberate orphan kept in /files.
- **Server decides "last reference" at delete time**: a conditional delete that refuses (e.g. 409) when any block still references the asset (`referencing_blocks` in `routes_assets.py`), and never strips tokens the way the existing DELETE does.
- **After the undo's ops have reached the server**, so the server isn't still seeing the reference the undo removed.
- **Offline or failure: leave the file**; the /files orphan filter still finds it.

Open questions: where the "fresh assets" list lives (HistoryEntry vs a side map keyed by entry), how the delete waits on the undo ticket's delivery, multiple outlines (journal days) each with their own history, the OpenAPI regen for the new route/param.

## Checklist

- [x] Server: conditional delete (`if_unreferenced`)
- [x] History entries carry `freshAssets`; undo manager releases discarded redo entries' uploads
- [x] Upload paths tag fresh uploads
- [x] e2e spec, architecture docs
- [x] perf/check.sh
- [x] proptest/check.sh

## Summary of Changes

Undoing an upload now deletes the uploaded file once redo is no longer possible, if nothing references it. Server: `DELETE /api/assets/{sha}?if_unreferenced=true` refuses with 409 while any block references the asset (check and delete under one `BEGIN IMMEDIATE`). Client: history entries carry `freshAssets` (uploads that came back `existing: false`, from `/upload`, paste, textarea drop, page drop and the composer); when an edit clears redo, `undoManager` hands the discarded entries' assets to `sync/assetRelease.ts`, which waits for the undo's and the clearing edit's server delivery and skips any sha re-uploaded in this tab since the undo (per-tab upload clock in `sync/assets.ts`). `pagehide` releases best-effort for undos the server has acknowledged, skipping back/forward-cache pages.

Verified: server pytest 2482 / pyrefly / ruff; web unit 3709, e2e 78 incl. `e2e/undo-upload-release.spec.ts`; proptest 68/68; perf backend+frontend unchanged. Follow-up: pkm-2121 (in-flight upload response race, low).
