---
# pkm-6r4r
title: 'Perf fixture has no :: attribute lines'
status: todo
type: task
priority: low
created_at: 2026-11-15T21:05:01Z
updated_at: 2026-11-16T13:49:38Z
parent: pkm-l79g
---

The backend perf fixture (server/tooling/perfcheck/fixture.py) generates no `Key::` lines, so the `query/records` scenario only measures line records with empty cells. Page records, the page/line attribute fetches, insert points and cell building go unmeasured, so a regression there (a correlated child-count subquery losing its index, say) passes the gate. Add attribute lines to the fixture. This changes the fixture hash, so it is a deliberate rebaseline of every backend scenario.


## Summary of Changes

The backend perf fixture (`server/tooling/perfcheck/fixture.py`, `_Gen.attribute_pages`) now has book-like pages with top-level `Key:: value` lines (near-duplicate keys, mixed-case and blank values, repeated keys, a multi-line value, a `::` line with children) and a reading-list page whose lines hold `Tags::`/`Local copy::` children. The query/records scenario now reads page and line records with cells (vm_steps_k 82 -> 348 at the same product). The fixture hash changed, so every backend scenario was rebaselined with `perf/check.sh backend --rebaseline` at the merge base.

Observed while rebaselining, not investigated: every single-op ops scenario gained exactly 34 trigger statements on the new fixture (ops/edit-1 9 -> 43, paste-50 414 -> 448).


## Reopened: 34 extra trigger statements per op

Arthur, 2026-11-16: keep this open to explain the trigger-statement jump. On the new fixture every single-op scenario runs exactly 34 more trigger statements than on the old one, with the same product code on both sides of the rebaseline: ops/edit-1, edit-hashed-clean, edit-rename-replay 9 -> 43; create-missing-parent, edit-missing-block, move-missing-parent 22 -> 56; edit-hashed-conflict 29 -> 63; paste-50 414 -> 448. A constant offset regardless of op points at something per-batch, not per-block (a trigger whose cost scales with the number of `::` lines, attribute pages or distinct keys in the DB, say). The edited blocks are not on the new attribute pages. rename/hub also rose (trigger_statements 3020 -> 4493), as expected if the hub is now linked from Tags:: lines.

- [ ] Find which trigger(s) account for the +34 (trace statements for ops/edit-1 on both fixtures)
- [ ] Decide whether it is a real per-edit cost on attribute-heavy data (production has `Tags::` on thousands of blocks) and fix it, or explain why it is expected
