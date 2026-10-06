---
# pkm-mk4s
title: 'Props suites: capture and summarise fault-injection warnings'
status: in-progress
type: task
priority: normal
created_at: 2026-10-06T09:01:28Z
updated_at: 2026-10-06T09:52:44Z
---

The property suites (`proptest/check.sh web`, `web/src/props/`) print warnings from the harness's deliberate fault injection: product recovery logs such as `applyChanges: stale title holder, rebootstrapping StaleTitleHolderError`, the window FK-failure rebootstrap, and the SQLite engine's own `sqlite3_step() rc=… SQL = ROLLBACK TO sp` lines (`rc=1555` etc.). They scroll past by the hundred, so a new, unexpected warning (a recovery path firing where it shouldn't) is invisible.

Approach (option 2 of the choices discussed 2026-10-06; the strict "fail on unknown" variant is deferred until a stray line ever proves to be a real bug):

- In the shared props harness, each suite spies on `console.warn` (and `console.error` if the injected faults produce any) for its run.
- Classify each line against a small list of kinds the injected faults are expected to produce (engine constraint/rollback lines, each named rebootstrap or re-snapshot log).
- At the end of the suite, print one summary line per suite, e.g. `fault warnings: 214 engine PK conflicts, 12 stale-title rebootstraps`, and print every unclassified line verbatim, with the property/seed context if available.
- No global mute (`onConsoleLog` filter or `silent`), and an unknown line does not fail the property.

Engine lines reach `console.warn` through `sqlite3.config.warn`, which `web/src/replica/testDb.ts` rebinds to look `console.warn` up per call (pkm-iaa0), so a spy sees them. Check whether the props sync harness opens its replicas through `testDb.ts`; if not, it needs the same rebinding.

- [x] Inventory the warning kinds from a `proptest/check.sh web` run (all suites: sync, outline, ops, teeth)
- [x] Shared capture/classify/summary helper with unit tests (classification, unknown lines printed)
- [x] Wire into each props suite
- [x] `proptest/check.sh web` output: one summary line per suite, no raw noise; mutation-check that an injected unknown warning is printed
- [x] docs/architecture/property-checks.md: what the summary means and where to add a new expected kind
