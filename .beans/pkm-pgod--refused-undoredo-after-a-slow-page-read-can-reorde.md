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
