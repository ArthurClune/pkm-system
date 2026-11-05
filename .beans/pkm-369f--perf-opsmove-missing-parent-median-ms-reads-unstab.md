---
# pkm-369f
title: 'perf: ops/move-missing-parent median_ms reads unstable'
status: scrapped
type: bug
priority: normal
created_at: 2026-11-05T17:16:20Z
updated_at: 2026-11-05T17:46:22Z
---

perf/check.sh backend flagged ops/move-missing-parent as unstable (3.57 -> 7.25 ms) on the pkm-erii branch, which touches only MCP rendering and registration, not the ops path. Same family as pkm-6jge and pkm-tsb2: the harness, not the change. Investigate the scenario's variance (bootstrap vs check, load) and either stabilise it or widen its tolerance with a reason.


## Reasons for Scrapping
Folded into pkm-uubh, which treats this and its two siblings as one harness problem (a purely relative timing gate on ~3 ms scenarios) and fixes it with an absolute timing floor. The evidence from this bean is carried in pkm-uubh's table.
