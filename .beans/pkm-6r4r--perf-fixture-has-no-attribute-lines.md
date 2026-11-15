---
# pkm-6r4r
title: 'Perf fixture has no :: attribute lines'
status: todo
type: task
created_at: 2026-11-15T21:05:01Z
updated_at: 2026-11-15T21:05:01Z
parent: pkm-l79g
---

The backend perf fixture (server/tooling/perfcheck/fixture.py) generates no `Key::` lines, so the `query/records` scenario only measures line records with empty cells. Page records, the page/line attribute fetches, insert points and cell building go unmeasured, so a regression there (a correlated child-count subquery losing its index, say) passes the gate. Add attribute lines to the fixture. This changes the fixture hash, so it is a deliberate rebaseline of every backend scenario.
