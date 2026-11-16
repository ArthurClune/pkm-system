---
# pkm-6r4r
title: 'Perf fixture has no :: attribute lines'
status: completed
type: task
priority: low
created_at: 2026-11-15T21:05:01Z
updated_at: 2026-11-16T13:23:04Z
parent: pkm-l79g
---

The backend perf fixture (server/tooling/perfcheck/fixture.py) generates no `Key::` lines, so the `query/records` scenario only measures line records with empty cells. Page records, the page/line attribute fetches, insert points and cell building go unmeasured, so a regression there (a correlated child-count subquery losing its index, say) passes the gate. Add attribute lines to the fixture. This changes the fixture hash, so it is a deliberate rebaseline of every backend scenario.


## Summary of Changes

The backend perf fixture (`server/tooling/perfcheck/fixture.py`, `_Gen.attribute_pages`) now has book-like pages with top-level `Key:: value` lines (near-duplicate keys, mixed-case and blank values, repeated keys, a multi-line value, a `::` line with children) and a reading-list page whose lines hold `Tags::`/`Local copy::` children. The query/records scenario now reads page and line records with cells (vm_steps_k 82 -> 348 at the same product). The fixture hash changed, so every backend scenario was rebaselined with `perf/check.sh backend --rebaseline` at the merge base.

Observed while rebaselining, not investigated: every single-op ops scenario gained exactly 34 trigger statements on the new fixture (ops/edit-1 9 -> 43, paste-50 414 -> 448).
