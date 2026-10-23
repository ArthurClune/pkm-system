---
# pkm-85jq
title: Backlink breadcrumbs cost O(depth^3)
status: todo
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. The ancestor CTE builds a per-row path string, so breadcrumbs for deep blocks cost O(depth^3). Opus: rewrite without the path string. Probe (timing): docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-pages/p8_ancestors.py, which becomes a perf/ case.

- [ ] p8_ancestors as a perf/ case
- [ ] Rewrite the ancestor CTE without the per-row path string; same output
- [ ] perf/check.sh backend
- [ ] troubleshooting.md row
