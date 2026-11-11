---
# pkm-ygyx
title: Property suites for the machines the 2026-11-09 epic converts
status: in-progress
type: task
priority: normal
created_at: 2026-11-09T21:39:24Z
updated_at: 2026-11-11T17:29:02Z
parent: pkm-4gda
---

Plan: docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md § W19. Child of the 2026-11-09 maintainability review epic.


## From W11 (pkm-3iwm), sync suite mutants not yet run

| Mutant | Expected | Seeds 1 and 2 (2026-11-11, part b) | Note |
|---|---|---|---|
| renewal moves nothing | caught by `lease held` | caught on both: `lease held` after 13 and 388 runs, each through a `slowSnapshot` | |
| never renew | caught by `lease held` | caught on both: `lease held` after 13 and 388 runs, each through a `slowSnapshot` | |
| `runRecovery` ignores a refused renewal and commits | survives | survived both (2100 runs each) | still a reach fact: the new draws of part (b) (mark faults, a death at discovery, Discard) expire no lease in a running life |
| `commitRecovery` skips the fingerprint check | survives | survived both (2100 runs each) | still a reach fact: no new draw lets an edit persist mid-recovery with a reset after it |


## Scope decisions (Arthur, 2026-11-11)

- `useModal` (focus trap, modal stack): no property suite; the unit tests are enough. Dropped from W19.
- Split W19 into three branches: pure paging suites (files, backlinks, unlinked status); sync extensions (banner fold after pkm-9gkj, poison claim releases with the queue commands, leased delivery, late coalesce callers if drawable, W11's mutants); assistant chat driver shell.


## Checklist
- [x] (a) paging property suites: props/files, props/backlinks (backlinks paging and unlinked lifecycle). Found: Select all and Load more could overlap and show files twice; filesPaging now refuses the second.
- [x] (b) sync extensions: the banner checked against a model of the ranking (bannerModel.ts, with teeth); queue draws for mark failures, unmatched rounds, Discard, Retry and leased delivery (with teeth); late coalesce callers at the reconnect completion and the poison repair are never drawn (measured: none owed in either suite), so the unit tests stay their guard; W11 mutants run (table above). Open question for Arthur: a recovery leased flush posts while the lane claim holds (deliverLeased does not consult the barrier; the docs give the lane claim no rule over it), so the queue model does not judge leased POSTs against lane.
- [ ] (c) assistant chat driver shell
