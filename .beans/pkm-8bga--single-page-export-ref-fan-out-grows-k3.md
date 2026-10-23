---
# pkm-8bga
title: Single-page export ((ref)) fan-out grows K^3
status: todo
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. 11 KB of blocks referencing each other export as 279 MB. Needs an output bound and what the user sees when it is hit (Arthur's call), then opus. Probe: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-exports/p5_amplify.py.

- [ ] Arthur decides the bound and the user-visible result
- [ ] Red test from the probe
- [ ] Fix
- [ ] troubleshooting.md row
