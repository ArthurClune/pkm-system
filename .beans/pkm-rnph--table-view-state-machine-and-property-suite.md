---
# pkm-rnph
title: Table view state machine and property suite
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T18:29:06Z
parent: pkm-l79g
---

Task 8 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.


## Summary of Changes

- `web/src/tables/viewState.ts`: the pure view-state machine (`initialView`,
  `stepView`, `isDirty`, `viewFromOptions`, `optionsFromView`). Dirtiness
  compares filters as the macro text stores them (trimmed), so padding alone
  never offers a Save. A refetch (`loaded`) keeps a changed live view and lets
  an untouched one follow the new saved view; it never touches held rows.
  `saved` keeps held rows; filter, sort, view, columns and reset release them.
- `web/src/props/tables/`: gate suite `viewState.prop.ts` with a model written
  from the spec's Unsaved state and Editing bullets (`model.ts`; dirtiness is
  "Save would write different text", held rows derived from the step history),
  reach floors, and `teeth.prop.ts` with nine mutants including a refetch
  overwriting a changed live view.
- `optionsFromView` cannot spell "no sort" or an empty filter against a
  default that has one; the round trip holds for unsorted, unfiltered
  defaults, which is what a block passes.
