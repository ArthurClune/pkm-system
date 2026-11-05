---
# pkm-uubh
title: 'perf: timing gate trips on ~3 ms scenarios; add an absolute timing floor'
status: in-progress
type: bug
priority: normal
created_at: 2026-11-05T17:46:22Z
updated_at: 2026-11-05T17:57:23Z
---

The timing gate (server/tooling/perfcheck/compare.py) is purely relative: a timing is a candidate when it passes TIMING_FACTOR (2.0) times the baseline. For the many backend scenarios whose median is a few milliseconds, scheduling noise alone doubles the value, so the check keeps reporting **unstable** on branches that never touched the path. 21 of the 38 backend timing metrics have a baseline median under 5 ms; the frontend's smallest is 18 ms.

Seen so far (all on branches that did not touch the path; counts unchanged each time):

| Seen | Branch | Scenario | median_ms | Context |
|---|---|---|---|---|
| 2026-10-13 | feature/page-delete-unlinks | ops/edit-missing-block | 3.12 -> 6.46 | right after a 5-run --bootstrap on a quiet machine |
| 2026-10-29 | security/small-fixes | ops/edit-rename-replay | 3.02 -> 6.2 | another worktree running pytest (1-min load 4.5 -> 3.8 on 10 cores) |
| 2026-11-05 | feature/mcp-list-budget | ops/move-missing-parent | 3.57 -> 7.25 | — |

Decision (Arthur, 2026-11-05): fix it with an absolute floor. A timing becomes a candidate only when it passes TIMING_FACTOR times the baseline **and** worsens by more than a fixed number of milliseconds; the same floor applies when a reproduced timing is judged against the merge-base run, and to the faster report. Algorithmic regressions on these small scenarios stay caught by their exact/band counts (queries, scans, VM work).

Handover with the design, code pointers and the open value choice: docs/superpowers/handoffs/2026-11-05-perf-timing-floor.md (gitignored, on Arthur's machine).

## Todo
- [x] Choose the floor value (proposal in the handover: 5 ms) and add it beside TIMING_FACTOR
- [x] Apply it in _judge (candidate and faster) and _confirm_timing; leave bootstrap alone
- [x] Tests in server/tests/test_perfcheck_compare.py: a 3 -> 7 ms move passes, a 3 -> 9 ms move with floor 5 is a candidate, a 100 -> 210 ms move is still a candidate, confirm() on a small timing
- [x] Update docs/architecture/checks.md § Performance gate (the class table and the confirm table name the floor) and run_core.py's verdict text if it states the rule
- [ ] Run perf/check.sh backend and frontend on the branch; no re-baseline needed (the floor only narrows what counts as a candidate)
