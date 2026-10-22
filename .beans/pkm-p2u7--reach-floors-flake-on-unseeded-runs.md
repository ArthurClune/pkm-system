---
# pkm-p2u7
title: Reach floors flake on unseeded runs
status: completed
type: task
priority: normal
created_at: 2026-10-21T22:17:40Z
updated_at: 2026-10-22T07:44:04Z
parent: pkm-a1xk
---

Reach floors were measured with seeded runs; unseeded runs vary more and flake. Fix by construction where the category is a generator choice; re-measure the rest unseeded.

- [x] Measure each floored test 30x unseeded
- [x] Parametrise category floors (variant, flag, route)
- [x] Re-set content-shape floors from unseeded data
- [x] Re-verify 30x unseeded, floors still bite
- [x] Gates: pytest x2, pyrefly, ruff

## Summary of Changes

Floors were measured with seeded runs; unseeded runs vary far more. Categories the generator chose (flag state, variant kind, title family, title mode, migration mode) now run as separate properties or pytest parameters, so they are reached by construction. Content-shape and outcome floors were re-set to about half the lowest share over 30 unseeded runs; labels under five events in a run lost their floor.
