---
# pkm-49cm
title: Shared table UI (DataTable, CellEditor, toolbar, notice)
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T19:08:13Z
parent: pkm-l79g
---

Task 11 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.


## Summary of Changes

- `web/src/tables/DataTable.tsx`: sortable headers (`<button>` in `th`, `aria-sort`, arrow on the sorted column), `.stale` rows with a "no longer matches" label, and one cell editor driven by `stepEditor`. Tab order is the rendered editable cells, row-major, via `neighbourCell`. An open cell whose row, column or editability goes away commits to the row captured when it opened.
- `web/src/tables/CellTextarea.tsx`: the cell editor, a `<textarea rows={1}>` (never an `<input>`: iPad Safari keeps Tab inside an input). Enter commits, Shift-Enter is left to the textarea, Esc cancels, Tab/Shift-Tab commit and move. A capture-phase document mousedown outside commits. Its portalled, fixed popup holds the cell hint, the column's repeated values with counts, or `[[`/`#` page titles via `useAutocomplete`, `useTitleOptions`, `buildRows`, `AutocompletePopup` and `applyCompletion`. Named `CellTextarea`, not `CellEditor`: on macOS's case-insensitive filesystem `./CellEditor` resolves to `cellEditor.ts`.
- `web/src/tables/cellKeys.ts` (core): what a key means in the cell editor.
- `web/src/tables/island.ts`: stops clicks and plain keys at a table surface's root so the host block never sees them; Cmd/Ctrl chords go on to the app's window shortcuts.
- `TableToolbar.tsx`, `WriteNotice.tsx`; `placeUnderAnchor` in `popoverPosition.ts`; `supportsFieldSizing` exported from `useBlockDraft.ts`.
- Styles in `styles.css` § Tables; documented in `docs/architecture/styling.md` § Controls and § Focus.


Review fixes:
- With a block selection active, Shift-Cmd-ArrowUp or Cmd-C in a table's cell or filter used to act on the selected outline blocks. Cause: the click into the table stops propagating, so the selection survives, and `EditableBlockTree`'s keydown read the chords. Fix: that keydown now ignores editable targets (`isEditableTarget`, shared with `UndoRedoKeys` in `web/src/editableTarget.ts`).
- The cell editor no longer commits on a mousedown in the open cell's own padding.
- It commits when focus leaves by keyboard. It does not commit when the window loses focus.
- An open cell that has changed commits when the table unmounts.
- The scroll listener runs only while the popup shows.
