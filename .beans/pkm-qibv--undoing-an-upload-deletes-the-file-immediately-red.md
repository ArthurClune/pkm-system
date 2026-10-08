---
# pkm-qibv
title: Undoing an upload deletes the file immediately; redo is cleared
status: completed
type: bug
priority: normal
created_at: 2026-10-08T07:24:22Z
updated_at: 2026-10-08T07:37:01Z
---

Supersedes pkm-w4ts's timing. Arthur's product call (2026-10-08): undoing an upload should delete the file as soon as the undo reaches the server, if nothing else references it, rather than waiting until redo is gone. Undo of an upload is final: it clears the redo stack.

Keep: server conditional DELETE ?if_unreferenced=true; freshAssets (existing:false only) on history entries; failed/offline undo leaves the file.
Remove: release-on-redo-clear (recordEntry discarded), pagehide/keepalive release, bfcache exception, per-tab upload clock, keep veto. pkm-2121 becomes moot.

## Checklist
- [x] history.ts: takeUndo clears redo when the entry has freshAssets; recordEntry back to plain state
- [x] undoManager.ts: performUndo releases freshAssets after the undo's delivery; drop receipts, pagehide, clock
- [x] assetRelease.ts / assets.ts / UndoRedoKeys.tsx: remove keep veto, releaseOnUnload, upload clock
- [x] vitest rewritten; e2e spec reworked
- [x] docs: files-and-assets, frontend-editor, troubleshooting row, superseded note on 2026-10-07 spec
- [x] pnpm verify
- [x] proptest/check.sh
- [x] perf/check.sh frontend
- [x] scrap pkm-2121

## Summary of Changes

Undoing an upload is now final: takeUndo clears the redo stack when the entry has freshAssets, and performUndo sends the conditional DELETE ?if_unreferenced=true for each fresh sha once the undo's write is delivered (a failed delivery leaves the files). Removed: release when redo clears (recordEntry's discarded), the pagehide/keepalive release and its back/forward-cache exception, the per-tab upload clock, the keep veto, and recordHistory's write-ticket parameter. Server unchanged.

Verified: pnpm verify (typecheck, unit 3692, e2e 78 incl. reworked undo-upload-release.spec.ts); proptest 68/68; perf frontend no changes. pkm-2121 scrapped as moot.
