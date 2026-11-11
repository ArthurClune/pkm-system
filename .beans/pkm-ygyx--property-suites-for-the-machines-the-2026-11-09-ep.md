---
# pkm-ygyx
title: Property suites for the machines the 2026-11-09 epic converts
status: todo
type: task
priority: deferred
created_at: 2026-11-09T21:39:24Z
updated_at: 2026-11-11T13:19:57Z
parent: pkm-4gda
---

Plan: docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md § W19. Child of the 2026-11-09 maintainability review epic.


## From W11 (pkm-3iwm), sync suite mutants not yet run

| Mutant | Expected | Note |
|---|---|---|
| renewal moves nothing | caught by `lease held` | caught on one seed in T7; a second seed not run |
| never renew | caught by `lease held` | caught on one seed in T7; a second seed not run |
| `runRecovery` ignores a refused renewal and commits | survives | nothing draws a refused renewal in a running life unless another bug already expired the lease: a reach fact |
| `commitRecovery` skips the fingerprint check | survives | needs a stall that lets an edit persist mid-run and a reset after it: a reach fact |
