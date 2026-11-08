---
# pkm-7knn
title: 'Outline: a block drag whose source row is removed mid-drag never ends; a later file drop moves the stale block'
status: completed
type: bug
priority: low
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-08T15:04:31Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding outline F6. Verdict: HOLDS-NARROWER.

A remote structural change that removes or reparents the dragged row during
the drag leaves the drag state set (dragend fires at a detached node). Any
later external drag over an outline is treated as that block drag: a Finder
file drop moves the old block (undoable) and the files are not uploaded. A
window-level `dragend` listener would not fix it.

- [x] Red test
- [x] Tag block drags with a custom MIME type and treat only drags carrying it as block drags

## Summary of Changes

The bullet sets `BLOCK_DRAG_TYPE` (`outline/dnd.ts`) on its dataTransfer. `useDropZone.dragOf` ends a block drag at the first drag event that carries `"Files"` without the type, so a later Finder drop uploads instead of moving the old block. Any other event is taken for the block drag, since WebKit may list its types empty or without the custom one (unverified either way on iPadOS). The handle also listens for its own `dragend` (`onDragEndBlock`, new on `OutlineHandlers`, supplied by `EditablePage` in place of the container's `onDragEnd`), which ends the drag where the engine fires `dragend` at a detached handle. The three jsdom DataTransfer stubs became `test-helpers.dragTransfer`. Tests: `EditablePage.fileDrop.test.tsx`, `EditableBlockTree.dnd.test.tsx`.
