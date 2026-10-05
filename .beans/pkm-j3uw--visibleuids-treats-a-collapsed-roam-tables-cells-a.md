---
# pkm-j3uw
title: visibleUids treats a collapsed Roam table's cells as hidden
status: completed
type: bug
priority: normal
created_at: 2026-10-05T11:01:51Z
updated_at: 2026-10-05T20:26:01Z
---

tree.ts visibleUids skips the children of every collapsed block, but the renderer (EditableBlockTree) shows the cells of a valid Roam {{table}} block even when it is collapsed (imported tables are collapsed). So keyboard navigation and selection ranges that read visibleUids disagree with what is on screen inside tables. Pre-existing; found in review of the restored-focus fix on feat/pkm-f7zv-outline-props, which introduced a shared 'hides its children' predicate that visibleUids could adopt.


Also: web/src/props/outline/reading.ts readingRows' `hidden` has the same mismatch (harmless while sequenceArb draws no table macros). tree.ts hidesChildren is the shared predicate to adopt.


## Summary of Changes

- `visibleUids` (arrow navigation) hides by `hidesChildren`, so a collapsed valid Roam table's cell rows, shown while editing inside the table, are navigation stops. `readingRows` in the outline property uses the same predicate (`model.ts` rehide notes it matches only while no table macro is drawn).
- Ruling (Arthur, 2026-10-05): a block selection treats a valid table as one row, collapsed or not, since a selection clears focus and every table renders as its grid. New `selectableUids` orders selections; `startSelection` lifts an anchor in a cell to the outermost table; `selectionText` copies a selected table's subtree so it pastes back as a table.
- Docs: frontend-editor.md rule rows; troubleshooting.md row.
- Gates: pnpm verify (3551 unit, 72 e2e); proptest outline; full proptest earlier on the branch failed only on the pre-existing ops finding filed as pkm-rrqu (reproduces on main); perf frontend unchanged (run before the selection change). Mutation checks on navigation, selection order, copy and anchor lift.
- Real-keypress check: arrows step through cell rows of collapsed and expanded tables both ways; Shift+Down passes each table in one press; Shift+Down from a cell selects table + next block; Cmd+C writes the table with tab-indented cells.
