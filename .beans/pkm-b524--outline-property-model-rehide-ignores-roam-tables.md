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
