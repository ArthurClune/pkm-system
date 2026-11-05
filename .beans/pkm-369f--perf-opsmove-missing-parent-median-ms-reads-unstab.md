---
# pkm-369f
title: 'perf: ops/move-missing-parent median_ms reads unstable'
status: todo
type: bug
created_at: 2026-11-05T17:16:20Z
updated_at: 2026-11-05T17:16:20Z
---

perf/check.sh backend flagged ops/move-missing-parent as unstable (3.57 -> 7.25 ms) on the pkm-erii branch, which touches only MCP rendering and registration, not the ops path. Same family as pkm-6jge and pkm-tsb2: the harness, not the change. Investigate the scenario's variance (bootstrap vs check, load) and either stabilise it or widen its tolerance with a reason.
