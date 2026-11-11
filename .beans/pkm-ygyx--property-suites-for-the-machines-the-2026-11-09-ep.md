---
# pkm-ygyx
title: Property suites for the machines the 2026-11-09 epic converts
status: completed
type: task
priority: normal
created_at: 2026-11-09T21:39:24Z
updated_at: 2026-11-11T19:40:11Z
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
- [x] (c) assistant chat driver shell: props/assistant/driver.prop.ts drives the real createChatDriver with a fake ChatClient (every request's opening, events, settling and abort its own action) on vitest's fake setTimeout, clearTimeout and Date, judging each published state against the pure machine stepped on the results the fake owes it, and the I/O rules of frontend.md § The chat machine (driverRun.ts: agree, run, retry, one, stop, fallback, abort, delete), with floors from 30 runs and committed teeth (driverTeeth.prop.ts). Found: a Stop during a 409's back-off still sent the retry after Stop; the back-off now checks again after its sleep.


## Summary of Changes

- (a) Paging property suites: `props/files` and `props/backlinks` (backlinks paging and the unlinked lifecycle), with floors and teeth. Found: Select all and Load more could overlap and list files twice; `filesPaging` now refuses the second.
- (b) Sync extensions: each session's banner checked against `sync/bannerModel.ts`; queue draws for mark failures, unmatched rounds, Discard, Retry and leased delivery, with teeth; W11's mutants run (table above). Late `coalesce` callers at the reconnect completion and the poison repair are never drawn, so their unit tests stay the guard. Open question filed as pkm-rx21 (a recovery's leased flush posts while the lane claim holds).
- (c) Chat driver shell: `props/assistant/driver.prop.ts` with `driverRun.ts`, `driverArbitraries.ts`, `driverTeeth.prop.ts` and fixed-scenario `driverRun.test.ts`; checks.md § Property gate's `assistant/` row names it.
  - Bug fixed: pressing Stop while the driver was backing off from a 409 ("conversation busy", the server still finishing the previous turn) still sent the message again after Stop, so the server reserved a turn the user had stopped and the stop POST had to end it. Cause: `streamWithBusyRetry` checked `keepTrying()` only before its sleep. Rule: frontend.md § The chat machine, "retries no 409 after Stop". Pinned by `chatDriver.test.ts` (`a Stop during a 409's back-off sends no retry`).
