---
# pkm-8ax9
title: Undo of a page whose outline session is released replays recorded keys
status: completed
type: bug
priority: normal
created_at: 2026-10-05T10:42:31Z
updated_at: 2026-10-05T20:00:35Z
---

undoManager.dispatch re-keys history placements (anchors) against the page's mounted session tree. When the page's session has been released (Cmd-Z after navigating away), the recorded order_idx values ship unchanged, which is right only if nothing shifted that page's keys since recording. Candidate fixes: resolve against the replica's tree for that page, or defer the dispatch until the session mounts. Found in review of the undo-anchor fix on feat/pkm-f7zv-outline-props.


## Summary of Changes

- `undoManager.dispatch`: with no session for the entry's page, reads the page through the editor's own loader (`loadOutlineBlocks` + `substituteMissingDaily`), then re-keys placements and stamps base hashes against it before enqueueing; then navigates as before. Also closes the online-only unstamped-undo hole in the same path.
- Dispatches are serialized in keypress order: a mounted page's undo queues behind an earlier one still reading. A failed read falls back to the recorded, unstamped batch with a warning.
- Test seams `setHistoryPageLoader`, `historyIdle`. New tests: re-key against the loaded page (the bean's scenario: move, navigate away, a remote insert at the top, undo), stamping against the loaded tree, ordering behind a deferred read, read failure, throwing enqueue.
- Docs: frontend-editor.md rule row; troubleshooting.md row.
- Gates: pnpm verify (3533 unit, 72 e2e), proptest web (68), perf frontend unchanged.

- Real-app check (scratch server, real keypresses): move up, navigate away, remote insert at top, Cmd-Z → x, b0, b1, b2 on screen and server.
