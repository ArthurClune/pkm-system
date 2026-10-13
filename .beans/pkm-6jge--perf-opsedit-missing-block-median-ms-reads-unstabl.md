---
# pkm-6jge
title: 'perf: ops/edit-missing-block median_ms reads unstable after a bootstrap'
status: todo
type: bug
created_at: 2026-10-13T21:52:17Z
updated_at: 2026-10-13T21:52:17Z
---

Seen 2026-10-13 on feature/page-delete-unlinks: right after `perf/check.sh backend --bootstrap` (5 quiet runs), a re-check reported `ops/edit-missing-block` median_ms 3.12 -> 6.46, verdict **unstable**. The branch does not touch that path's timing (counts unchanged), so this is the harness. Per AGENTS.md an unstable verdict gets a bean against the harness, not a fix mid-feature.

## Todo
- [ ] Reproduce: bootstrap then check on a quiet machine, several times
- [ ] Find why this scenario's timing swings (warm-up, GC, fixture size)
