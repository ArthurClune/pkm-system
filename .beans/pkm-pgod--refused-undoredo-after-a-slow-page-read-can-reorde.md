---
# pkm-pgod
title: Refused undo/redo after a slow page read can reorder history
status: in-progress
type: bug
priority: low
created_at: 2026-10-24T14:58:27Z
updated_at: 2026-10-25T09:38:33Z
parent: pkm-mfd0
---

undoManager's unmounted path awaits a page read before judging depth. If a new edit is recorded during that wait and the replay is then refused: a refused redo goes back onto a redo stack the new record had cleared (so it can replay on top of the new edit), and a refused undo goes on top of the newer record. Needs an outline near the depth cap plus the async window.

- [x] Red tests for both orders in undoManager.test.ts
- [x] restoreEntry: restore a redo only while the stacks are unchanged since the take; insert an undo below entries recorded after the take
- [x] Test the epoch guard on the restore (reset during a pending page read leaves no notice and no navigation) — that mutant currently survives

## Summary of Changes

74da7913: `restoreEntry(state, entry, kind, taken)` restores a refused replay as though it had been refused at the take. `taken` is the state the take returned. A refused undo goes back below every entry recorded since the take. A refused redo is dropped if a record followed its take. `dispatchUnmounted` checks the history epoch again once the page read settles, whether it resolved or threw. So a reset during the read sends nothing, shows no notice and navigates nowhere. The history test that pinned the old order was rewritten.

33cbcc5e adds the case of a reset during a read that then fails. Docs: `frontend-editor.md § Rules an edit must not break` gives the restore order, and the Editor table in troubleshooting.md gains a row. Known open interleaving: a redo pressed while an undo awaits its read can duplicate an entry, filed separately (25209abf).
