---
# pkm-9b8n
title: Multi-block selection for copying
status: completed
type: feature
priority: normal
created_at: 2026-07-11T20:37:03Z
updated_at: 2026-07-12T07:53:58Z
---

Currently only a single block can be highlighted/selected. Want to be able to select multiple blocks (e.g. shift-click, drag across blocks, or keyboard shift+arrow) so their content can be copied out together.

Checklist:
- [ ] Selection model: extend selection across multiple blocks (mouse drag, shift-click, shift+arrows)
- [ ] Visual highlight for the selected block range
- [x] Copy puts all selected blocks' text on the clipboard in document order

## Summary of Changes

Shift+Up/Down from a focused block's top/bottom edge starts a multi-block selection (anchor = current block, head = neighbour); further Shift+Up/Down extends it, Escape/click/plain-arrow exits, and Cmd/Ctrl+C copies the selected blocks' text joined by newlines in document order. While selecting there is no editing textarea — the tree container takes focus and owns the keyboard. Selected rows get a .selected highlight (--color-selection-bg).

Scope decision (agreed with user): Shift+Arrow only for this bean. Mouse drag-across and Shift+Click range selection were deferred.

Pure logic in web/src/outline/blockSelection.ts (selectedUids/extendSelection/selectionText, unit-tested); selection state + handlers in useOutline; wiring + copy in EditableBlockTree.
