---
# pkm-b524
title: 'Outline property: model rehide ignores Roam tables'
status: todo
type: task
priority: deferred
created_at: 2026-10-05T20:48:03Z
updated_at: 2026-10-05T20:48:03Z
---

web/src/props/outline/model.ts rehide marks a row hidden when any ancestor is collapsed, while readingRows (and the editor, via tree.ts hidesChildren) does not hide a valid Roam table's cells. They agree today only because the outline property's arbitraries draw no {{table}} macros (noted at rehide). If the property ever draws tables (worth it: tables have their own navigation and selection rules, see frontend-editor.md), the model needs a row-based equivalent of hidesChildren/roamTableRows, and its selection model needs the table-as-one-row rule (selectableUids).

## Note from pkm-mtxu

`modelRows`, `isTable` and `pathTo` in `web/src/props/outline/visibleTree.ts`
are an independent, row-based model of `hidesChildren`/`roamTableRows`: a valid
table (macro text, at least one row, every row a chain of cells with at most
one child) shows its cells only when the focus is on its ancestor path, and
every other collapsed block with children hides them. It was checked against
the rendered rows of `EditableBlockTree` and against `visibleUids` and
`selectableUids`, so `rehide` in `model.ts` can adopt it. The table-as-one-row
selection rule is the no-focus case there (`selectableUids`).
