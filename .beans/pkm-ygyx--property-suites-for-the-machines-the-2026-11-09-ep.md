---
# pkm-ygyx
title: Property suites for the machines the 2026-11-09 epic converts
status: in-progress
type: task
priority: normal
created_at: 2026-11-09T21:39:24Z
updated_at: 2026-11-11T14:44:02Z
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


## Scope decisions (Arthur, 2026-11-11)

- `useModal` (focus trap, modal stack): no property suite; the unit tests are enough. Dropped from W19.
- Split W19 into three branches: pure paging suites (files, backlinks, unlinked status); sync extensions (banner fold after pkm-9gkj, poison claim releases with the queue commands, leased delivery, late coalesce callers if drawable, W11's mutants); assistant chat driver shell.


## Checklist
- [x] (a) paging property suites: props/files, props/backlinks (backlinks paging and unlinked lifecycle). Found: Select all and Load more could overlap and show files twice; filesPaging now refuses the second.
- [ ] (b) sync extensions
- [ ] (c) assistant chat driver shell
