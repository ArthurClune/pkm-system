---
# pkm-rac1
title: Unit and property tests with tight time limits fail on a loaded machine
status: todo
type: task
priority: normal
created_at: 2026-11-11T05:04:59Z
updated_at: 2026-11-11T12:49:54Z
parent: pkm-4gda
---

Seen repeatedly while several agents ran suites at once (load average 20 to 50): src/replica/queueUnreadable.props.test.ts times out at its 5000ms limit, tooling/lintConfig.test.ts takes 19.4s alone against a 20s limit, and the outline property suite ran out of its time budget at about half its runs. Each passes on a quiet machine and at the base commit. Decide per test whether the limit measures something (then it stays and the run needs a quiet machine) or is only a hang guard (then give it room), and whether the outline suite's budget has enough margin over its quiet-machine time.


Also: the sync property suite's `lease held` invariant runs the recovery lease on real timers shortened to HARNESS_LEASE_MS (props/sync/harnessClient.ts). A `lease held` failure whose counterexample has no paced fault (slowSnapshot / stalledSnapshot) is first a machine-load question: rerun alone on a quiet machine before calling it a finding.
