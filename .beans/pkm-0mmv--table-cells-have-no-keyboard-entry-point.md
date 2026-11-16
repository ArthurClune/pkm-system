---
# pkm-0mmv
title: Table cells have no keyboard entry point
status: completed
type: task
priority: normal
created_at: 2026-11-15T21:05:01Z
updated_at: 2026-11-16T12:21:10Z
parent: pkm-l79g
---

In DataTable, sort headers are buttons and reachable by keyboard, but editable cells have no tab stop: a keyboard-only reader cannot open a cell without clicking first. Once one cell is open, Tab moves between cells. Give editable cells a focusable entry (roving tabindex, or Enter on a focused cell) without fighting the outline's own Tab handling.


Decision (Arthur, 2026-11-16): every editable cell is its own tab stop, with Enter to open it (not a roving tabindex).


## Summary of Changes

Symptom: a keyboard-only reader could not reach a table cell; Tab skipped from the headers to past the table. Fix: in `DataTable`, each cell that can open (editable column, and the host lets it open) is a tab stop, and Enter on it opens it. A cell closed by a key (Enter, Escape, Tab off either end) takes focus back; one closed by a click does not. Because a focused cell sits inside `.block-tree` and is not an editable target, `island` now marks the table (`data-table-island`) and `EditableBlockTree.onKeyDown` skips keys from inside it (`isInTableIsland`), so Cmd-Backspace, Shift-Cmd-Arrow or Cmd-C on a focused cell cannot act on a standing block selection. Rules: docs/architecture/frontend-editor.md § Tables and § The cell editor; keys in docs/keyboard.md § Tables. Arthur to check on the real iPad that Tab reaches a focused cell.
