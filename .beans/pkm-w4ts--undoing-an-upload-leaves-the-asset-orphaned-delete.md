---
# pkm-w4ts
title: 'Undoing an upload leaves the asset orphaned: delete it once redo is gone'
status: in-progress
type: bug
priority: normal
created_at: 2026-10-07T19:51:52Z
updated_at: 2026-10-07T19:59:08Z
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
- [ ] perf/check.sh
- [ ] proptest/check.sh
