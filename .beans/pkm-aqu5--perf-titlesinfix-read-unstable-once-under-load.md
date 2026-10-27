---
# pkm-aqu5
title: 'perf: titles/infix read unstable once under load'
status: todo
type: task
priority: deferred
created_at: 2026-10-25T13:17:05Z
updated_at: 2026-10-27T10:29:48Z
---

From the web clean-ups gate (2026-10-25). perf/check.sh backend, first run under load 4.8, reported titles/infix 'unstable' (1.92 -> 4.56 ms); a quiet re-run was clean. Per AGENTS.md an unstable verdict is a harness flake to track: check whether titles/infix's timing is sensitive to load (sample count, warm-up) or whether the load gate's threshold let a busy run through. (A runaway orphaned pytest at 100% CPU was also running at the time and has been stopped.)

- [ ] Reproduce under controlled load
- [ ] Tighten the scenario or the busy check


## Deferred (2026-10-27)

Arthur's ruling: seen once, under load with an orphaned pytest at 100% CPU; act only if it recurs on a quiet machine.
