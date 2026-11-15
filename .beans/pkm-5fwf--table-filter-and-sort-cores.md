---
# pkm-5fwf
title: Table filter and sort cores
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T18:19:52Z
parent: pkm-l79g
---

Task 7 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.

## Summary of Changes

Added the pure cores `web/src/tables/filter.ts` (parseFilter, matchesFilter) and `web/src/tables/sort.ts` (compareCells, sortRows) with unit tests and fast-check property tests.
