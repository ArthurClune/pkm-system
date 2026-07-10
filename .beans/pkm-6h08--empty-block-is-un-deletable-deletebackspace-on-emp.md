---
# pkm-6h08
title: 'Empty block is un-deletable: delete/backspace on emptied block should remove it'
status: completed
type: bug
priority: normal
created_at: 2026-07-10T18:55:32Z
updated_at: 2026-07-10T19:19:42Z
---

After removing all text from a block, pressing delete/backspace again should delete the block itself. Currently an empty block cannot be deleted.

## Summary of Changes

`backspaceAtStart` (web/src/outline/edits.ts) no-oped for any block at sibling index 0, so the first block among its siblings — including the sole block on a page — could never be deleted even when emptied. Now an empty, childless block at index 0 is deleted: focus lands on the parent (first child case), on the next sibling (first top-level block case), or is cleared (sole block; the page's empty click-to-create state takes over). Non-empty first blocks still no-op (nothing to merge into). Unit tests added for all three cases; verified end-to-end in the running app.
