---
# pkm-xrvv
title: SPA catch-all answers 404, not 500, for paths resolve() rejects
status: completed
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. NUL or over-long path components, and a symlink loop in web_dist (Path.resolve() raises RuntimeError on Python 3.12), make the anonymous SPA catch-all answer 500. Probe: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-exports/p4b_spa_exc.py; symlink loop: sec-exports/report.md finding 3.

- [x] Red test: NUL, over-long component and a symlink loop each answer 404 (status asserted, not just the body)
- [x] Catch ValueError, OSError and RuntimeError around resolve()/is_file() and answer 404
- [x] troubleshooting.md row

## Summary of Changes

The SPA catch-all wraps `resolve()` and `is_file()` and treats `ValueError`, `OSError` and `RuntimeError` as a path that names no file and serves the shell (a long `/page/<title>` reload must get the app). `test_a_path_resolve_rejects_gets_the_shell_never_a_500` asserts the status and body for NUL, over-long, deep, link-loop and long-title paths. Troubleshooting row added.
