---
# pkm-xrvv
title: SPA catch-all answers 404, not 500, for paths resolve() rejects
status: todo
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. NUL or over-long path components, and a symlink loop in web_dist (Path.resolve() raises RuntimeError on Python 3.12), make the anonymous SPA catch-all answer 500. Probe: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-exports/p4b_spa_exc.py; symlink loop: sec-exports/report.md finding 3.

- [ ] Red test: NUL, over-long component and a symlink loop each answer 404 (status asserted, not just the body)
- [ ] Catch ValueError, OSError and RuntimeError around resolve()/is_file() and answer 404
- [ ] troubleshooting.md row
