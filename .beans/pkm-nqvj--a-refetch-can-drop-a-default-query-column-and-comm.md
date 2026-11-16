---
# pkm-nqvj
title: A refetch can drop a default query column and commit its open cell
status: completed
type: bug
priority: normal
created_at: 2026-11-16T11:19:19Z
updated_at: 2026-11-16T14:56:07Z
---

In a query view nobody has touched, the columns come from the records (queryDefaults' defaultColumns). A resync refetch that no longer returns any record holding a key removes that column, so an open cell in it unmounts and DataTable commits its draft, the same jump the frozen-row hold prevents for rows. Found while fixing the vanishing held row; predates it. Likely fix: while a cell edit freezes the view, keep the columns it had.

## Summary of Changes

Symptoms, after writing a cell in a query table whose macro sets no `columns:` or `view:`, when a resync landed:
- a column the refetch's records no longer held vanished, and a draft open in it was written at once;
- if no returned record had a `::` line, the table switched to the blocks view, writing any open draft and losing the held rows;
- a held row's cell in a column the key stats no longer named showed blank, and writing it created a duplicate line.

Cause: a clean live view follows the saved one, whose view and columns are the data's defaults, recomputed from every refetch; DataTable commits a draft whose column or table stops rendering. queryColumns fell back to the label as key when the stats stopped naming it.

Fix: `stepQueryView` (web/src/tables/queryViewState.ts) wraps stepView and takes a snapshot of what was shown (view, column labels, key stats) in the step that freezes the rows, from the last committed render (`shownNow` in QueryResults); `showQuery` shows the snapshot's view and columns while rows are held, for each field the macro leaves to the defaults, and resolves keys from the current stats, then the snapshot's (`queryColumns`' fallback). stepView, its contract rows and its property suite are unchanged. A new property suite (web/src/props/tables/queryView.prop.ts, queryTeeth.prop.ts) checks stepQueryView, showQuery and holdRecords against queryModel.ts, written from the new `showQuery` table in docs/architecture/contracts/frontend-editor.md § The table view.

Doc: docs/architecture/frontend-editor.md § The table view.

Known limits:
- A draft opened before the first cell write is not protected: the hold starts at a write, as the row hold does. A refetch that drops that column, or makes blocks the default, still commits the draft.
- If another device edits the macro's `columns:` or `view:` during a held edit, the field switches between the snapshot and the macro's choice mid-hold, and a draft in a column the switch removes commits. Rare, and the macro's choice wins.
- A column change from the column menu of a held table starts from the columns on screen, so held columns the reader keeps become their own (pinned by a test).
- A sort or column change from a held table releases the hold, so the block then shows the live view. If a refetch made blocks the default during the hold, the table the reader acted in turns into the blocks view (no data is lost: the capture mousedown commits any open cell first). Carrying the table into the live view instead would make it dirty and offer a Save of `view: table` the reader never asked for.
