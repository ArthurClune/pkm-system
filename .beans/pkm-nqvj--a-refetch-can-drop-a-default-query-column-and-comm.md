---
# pkm-nqvj
title: A refetch can drop a default query column and commit its open cell
status: completed
type: bug
priority: normal
created_at: 2026-11-16T11:19:19Z
updated_at: 2026-11-16T14:09:13Z
---

In a query view nobody has touched, the columns come from the records (queryDefaults' defaultColumns). A resync refetch that no longer returns any record holding a key removes that column, so an open cell in it unmounts and DataTable commits its draft, the same jump the frozen-row hold prevents for rows. Found while fixing the vanishing held row; predates it. Likely fix: while a cell edit freezes the view, keep the columns it had.

## Summary of Changes

Symptom: after writing a cell in a query table with no `columns:` option, a reader typing in another cell saw that cell's whole column vanish and the draft get written as soon as a resync landed, when the refetch's records no longer held that key (for example, the only record holding it had left the query). A held row whose key the stats stopped naming also showed blank cells in that column, and a write there created a duplicate line.

Cause: the clean live view follows the saved one, whose columns are the data's defaults; a refetch recomputed them from the new records, and DataTable's column-gone path committed the open draft. queryColumns also fell back to the label as key when the stats no longer named it.

Fix: `holdColumns` (web/src/tables/queryView.ts) records, at the first refetch landing under a freeze, the default columns and key stats the view showed; `shownColumns` shows those while that freeze lasts, but only when the columns follow the defaults (no `columns:` in the macro and the view clean). Chosen columns are shown as they are, finding their keys in the held stats when the current ones lack them. The hold lives in QueryResults beside holdRecords; stepView is unchanged, so its contract and property suite are untouched.

Doc: docs/architecture/frontend-editor.md § The table view.
