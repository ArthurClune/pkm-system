---
# pkm-l79g
title: 'Tables and queries: sort, filter, edit and saved views'
status: completed
type: epic
priority: normal
created_at: 2026-11-15T15:38:47Z
updated_at: 2026-11-15T22:28:36Z
---

Query results as a table of each result's :: attributes; type-to-filter and sorting on queries and {{table}}; editable cells that write back to the source block; + New row on plain tables; saved views stored as options in the macro text. Spec: docs/superpowers/specs/2026-11-15-tables-and-queries-design.md
Plan: docs/superpowers/plans/2026-11-15-tables-and-queries.md

Phase A (tasks 1-2, blocks-view parent lines) can merge on its own before the rest.

## Summary of Changes

Query blocks show their results as a table (one row per record, a column per :: attribute), cards or blocks; plain {{table}} blocks gain the same type-to-filter, sort and editable cells, plus + New row. Views save as ` | name: value` options in the macro text. Server: /api/query items carry their parent line; GET /api/query/records maps results to records under one read snapshot; Python/TS option parsers kept in step by a parity fixture. Web: pure cores (filter, sort, view state, cell editor, records, table writes) with property suites for the two state machines; shared DataTable with a textarea cell editor (iPad Tab); query writes through the op queue with a bound Undo notice, plain-table writes through outline history (Cmd-Z). Phase A (parent lines) shipped first. Follow-ups are this epic's open children.
