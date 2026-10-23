---
# pkm-lbj1
title: Legacy deeply nested [[ makes rename/delete 500 (iterative rewrite)
status: completed
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T20:30:00Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. _unlink_range and _rewrite_range recurse per nesting level; legacy text with ~1,200 nested [[ (written before /api/ops refused it) makes rename, delete and delete-preview 500. Probe: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-pages/p5b_brackets_legacy.py.

- [x] Red test: the probe's 1,200-deep text through rename, delete and delete-preview
- [x] Iterative _unlink_range and _rewrite_range with identical output (equivalence test on ordinary nesting)
- [x] proptest/check.sh server (rename touches titles)
- [x] troubleshooting.md row

## Summary of Changes

- `unlink._unlink_range` and `rename._rewrite_range` keep an explicit stack
  of (gap start, window stop, remaining runs) frames instead of recursing.
  The frame order reproduces the recursive walk exactly, so spans are
  appended in the same order (`_unlink_bracket`'s alias filter depends on it).
- No other walker on the rename, delete or delete-preview paths recurses per
  nesting level: `refs.bracket_spans` and `refs.iter_bracket_spans` were
  already iterative; the remaining calls are regex scans.
- `tests/test_legacy_deep_brackets.py`: rename, DELETE and delete-preview at
  depth 3 and 1,200 over a legacy row inserted directly; the 1,200 cases
  raised `RecursionError` before the fix.
- `tests/test_bracket_walk_equivalence.py`: the recursive walks kept verbatim
  as the oracle; hypothesis compares span lists (order included) and the
  public `unlink_title_refs` / `rewrite_title_refs_map` output, with floors on
  the branches reached. Mutants: pop order, rescanning a run, and dropping
  the tail gap are caught in both modules; resuming at `end - 2` or stopping
  a child window at `end` are equivalent (no tag can start in or extend
  through `]]`).
- backend.md § Ref grammar states why the walks keep their own stack;
  troubleshooting.md row added.
- Not changed: `unlink_title_refs` still makes one full pass per nesting
  layer, so its cost is depth x length.
