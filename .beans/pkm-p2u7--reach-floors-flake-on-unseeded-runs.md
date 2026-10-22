---
# pkm-p2u7
title: Reach floors flake on unseeded runs
status: in-progress
type: task
created_at: 2026-10-21T22:17:40Z
updated_at: 2026-10-21T22:17:40Z
parent: pkm-a1xk
---

Reach floors were measured with seeded runs; unseeded runs vary more and flake. Fix by construction where the category is a generator choice; re-measure the rest unseeded.

- [ ] Measure each floored test 30x unseeded
- [ ] Parametrise category floors (variant, flag, route)
- [ ] Re-set content-shape floors from unseeded data
- [ ] Re-verify 30x unseeded, floors still bite
- [ ] Gates: pytest x2, pyrefly, ruff
