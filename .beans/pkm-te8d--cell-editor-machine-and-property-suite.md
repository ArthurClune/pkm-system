---
# pkm-te8d
title: Cell editor machine and property suite
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T18:44:12Z
parent: pkm-l79g
---

Task 10 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.


## Summary of Changes

- `web/src/tables/cellEditor.ts` (Core): `stepEditor`, the shared cell
  editor. Enter, a click elsewhere, Tab and opening another cell write the
  draft, outer whitespace trimmed, only when it differs from the original
  trimmed; Esc never writes; opening the open cell again changes nothing;
  every event but `open` is ignored while idle. `neighbourCell` steps along
  the row-major editable cells and is null past either end or for a cell
  not in the order.
- `web/src/props/tables/cell*.ts`: the cell editor property in the tables
  gate suite. An independent model (`cellModel.ts`) from the design's
  "Editing" section; a runner (`cellRun.ts`) that reads values from a store
  writes land in and asks `neighbourCell` for Tab's next cell; invariants
  state, writes, idle, one-write, not-original, cancel-no-write,
  trimmed-draft and neighbour; reach floors on every labelled path; seven
  teeth mutants in `cellTeeth.prop.ts`.
