---
# pkm-h1w7
title: Web ops property runs near its time budget
status: scrapped
type: task
priority: deferred
created_at: 2026-10-25T03:18:21Z
updated_at: 2026-11-11T13:34:37Z
---

From the pkm-gc3n/bppf fix wave (2026-10-25). The web ops property takes 78-81 s against its 120 s budget on a quiet machine (76 s on main without the limit texts); ~62% of its time is spent in the server's routes, so under load from parallel sessions' suites it can overrun and fail the gate for any branch touching ops or sync. Harness work, not a property change: profile the server side of the harness (route latency per call), or raise the budget with the measured basis recorded.

- [ ] Profile the harness's server time per call
- [ ] Cut it, or raise the budget with the measured basis in the commit


## Deferred (2026-10-27)

Arthur's ruling: about 35% headroom on a quiet machine; act only if the budget is overrun in a gate. Removed from the security epic.


## Reasons for Scrapping

The ruling was to act only if a gate overruns the budget, and none has. pkm-rac1 covers the general problem of time-limited tests failing on a loaded machine. (Arthur, 2026-11-11.)
