---
# pkm-tsb2
title: 'perf: ops/edit-rename-replay median_ms reads unstable under load'
status: todo
type: bug
priority: low
created_at: 2026-10-29T17:03:19Z
updated_at: 2026-10-29T17:03:19Z
---

perf/check.sh backend on security/small-fixes (2026-10-29) read ops/edit-rename-replay median_ms 3.02 -> 6.2 as unstable, with 1-min load 4.5 -> 3.8 on 10 cores while another worktree ran pytest. The branch did not touch the ops or rename path (importer report and assistant events only). Same shape as pkm-6jge. Look at whether the scenario's timing needs more samples or a load-aware retry before the verdict.

- [ ] Reproduce under load and quiet
- [ ] Fix the harness so this scenario does not read unstable from concurrent load
