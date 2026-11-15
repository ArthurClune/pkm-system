---
# pkm-s8yh
title: 'Plain tables: sort, filter, edit, + New row and Save'
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T20:44:01Z
parent: pkm-l79g
---

Task 13 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.


## Summary of Changes

Plain `{{table}}` blocks now sort, filter, edit cells in place, add a row
("+ New row") and save their filter and sort into the macro
(`{{table | filter: … | sort: Col asc}}`). "Edit as text" in the toolbar
opens the block's raw text. A click inside the table no longer focuses
the table block.

- `components/roamTable.tsx` is an eager shell: it shows the read-only
  table until `components/PlainTable.tsx` loads, then swaps it in.
  `PlainTable` and `QueryResults` are one lazy chunk (`tablesChunk.ts`).
  `components/lazyComponent.ts` (`lazyLoader`, `useLazy`) is the shared
  loader. QueryBlock, PdfEmbed and the local file picker use it too.
- Writes go through the new `OutlineHandlers.onEditInBlock(uid, plan)`.
  It runs a planner from the lazy chunk against the live tree inside
  `useOutline.run`, so each write is one undo step and Cmd-Z undoes it.
  This covers a cell's text, a padding cell's created chain and a new
  row. `onSetText` and `onToggleTodo` now go through the same helper.
  Plain-table writes show no write notice.
- Cores: `tables/tableWrites.ts` (`planTableCellWrite`, `planNewRow`) and
  `tables/plainTable.ts` (columns, body rows, Save against the block's
  own text with a round-trip check). `tables/viewRows.ts` is the filter,
  sort and freeze step shared with `queryView.shownRows`.
- DataTable gains `openCell`/`onCellOpened`, which opens a new row's
  first cell once the row renders. It also gains `Column.heading`: a
  rich header, where a click on a link in it does not sort.
