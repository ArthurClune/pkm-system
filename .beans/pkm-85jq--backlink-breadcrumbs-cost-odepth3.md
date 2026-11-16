---
# pkm-85jq
title: Backlink breadcrumbs cost O(depth^3)
status: completed
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-11-16T10:20:47Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. The ancestor CTE builds a per-row path string, so breadcrumbs for deep blocks cost O(depth^3). Opus: rewrite without the path string.

- [ ] p8_ancestors as a perf/ case
- [ ] Rewrite the ancestor CTE without the per-row path string; same output
- [ ] perf/check.sh backend
- [x] troubleshooting.md row

## Summary of Changes

- The ancestor walk for backlink breadcrumbs no longer builds a per-row path string; it reads each ancestor once (server CTE and the replica's fetchAncestors, changed together as backend.md requires), keeping the same output and cycle termination (UNION dedup plus a seen-set). Depth 1,000: 7.95 s → 0.036 s; the probe at depth 2,000: 57.86 s → 0.22 s; byte-identical responses.
- New perf case page/deep-backlinks (work 259k → 7k steps); three backlink scenarios ratcheted down.
- Equivalence tests old vs new (server and replica) over random trees incl. cycles and the depth cap; mutants caught.
- Docs: owning architecture section and a troubleshooting row.
- Residual (output amplification d²/2) filed separately.
