---
# pkm-rac1
title: Unit and property tests with tight time limits fail on a loaded machine
status: completed
type: task
priority: normal
created_at: 2026-11-11T05:04:59Z
updated_at: 2026-11-11T15:20:57Z
parent: pkm-4gda
---

Seen repeatedly while several agents ran suites at once (load average 20 to 50): src/replica/queueUnreadable.props.test.ts times out at its 5000ms limit, tooling/lintConfig.test.ts takes 19.4s alone against a 20s limit, and the outline property suite ran out of its time budget at about half its runs. Each passes on a quiet machine and at the base commit. Decide per test whether the limit measures something (then it stays and the run needs a quiet machine) or is only a hang guard (then give it room), and whether the outline suite's budget has enough margin over its quiet-machine time.


Also: the sync property suite's `lease held` invariant runs the recovery lease on real timers shortened to HARNESS_LEASE_MS (props/sync/harnessClient.ts). A `lease held` failure whose counterexample has no paced fault (slowSnapshot / stalledSnapshot) is first a machine-load question: rerun alone on a quiet machine before calling it a finding.


## Checklist

- [x] queueUnreadable.props.test.ts: guard; 0.83s quiet; vitest default now 30s
- [x] lintConfig.test.ts: guard; 1.8s (5s under coverage) worst test; 60s file-wide
- [x] EditablePage depth-cap, rewind, Tab-depth tests: guards; 0.27-0.44s; 30s default
- [x] outline property: guard; 72s of 90s; now 240s
- [x] draft, ops, sync property budgets raised to about 3x quiet time
- [x] sync lease held message: left as is (see below)

## Summary of Changes

All named limits were hang guards, not measurements. vite.config.ts sets testTimeout 30s for unit tests; lintConfig sets 60s file-wide (replacing ESLINT_TIMEOUT_MS on 44 tests; five had none); PROPERTY_LIMIT_MS: outline 90s to 240s (quiet 72s), draft 45s to 120s (17-19s), ops 120s to 240s (71s), sync 420s to 840s (288s) with vitest.props.config.ts testTimeout 600s to 1200s. A budget overrun already reports as a budget problem (gateReport.budgetReport), not a finding. checks.md Property gate gains one sentence. The lease held message stays unchanged: the oracle does not know which faults a counterexample held, so "likely load" would not be clearly true.
