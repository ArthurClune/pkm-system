---
# pkm-lbj1
title: Legacy deeply nested [[ makes rename/delete 500 (iterative rewrite)
status: todo
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. _unlink_range and _rewrite_range recurse per nesting level; legacy text with ~1,200 nested [[ (written before /api/ops refused it) makes rename, delete and delete-preview 500. Probe: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-pages/p5b_brackets_legacy.py.

- [ ] Red test: the probe's 1,200-deep text through rename, delete and delete-preview
- [ ] Iterative _unlink_range and _rewrite_range with identical output (equivalence test on ordinary nesting)
- [ ] proptest/check.sh server (rename touches titles)
- [ ] troubleshooting.md row
