---
# pkm-c1hj
title: 'Perf harness: W/warm first_outline_ms flagged unstable under concurrent test load'
status: todo
type: bug
priority: low
created_at: 2026-10-01T13:30:00Z
updated_at: 2026-10-01T13:30:00Z
---

perf/check.sh frontend reported W/warm first_outline_ms as unstable (baseline 206 ms, now 582 ms) on 2026-10-01 while checking the pkm-iskx branch (web brand types only, no runtime change on the outline path). Another worktree's server and web test suites were running on the machine at the same time. On the same day, the pkm-he87 check under similar load reported K/drag-bottom and K/drag-top handler_ms as 'improvements' (55.9 -> 24.2 ms, 16.5 -> 6.5 ms), and the rewritten baseline was discarded.

Question: does the harness detect a loaded machine, and should it refuse to run or retry, rather than report unstable or improved timings (and rewrite baselines on an improvement)?

- [ ] Reproduce: run perf/check.sh frontend on main twice, once idle and once with a pnpm verify running in another worktree
- [ ] Decide: a load check (os.loadavg or a calibration probe) that warns or refuses, and/or no baseline rewrite on improvements when variance is high
- [ ] Implement and document in docs/architecture/performance-checks.md
