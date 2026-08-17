---
# pkm-nvxh
title: Remove avoidable per-keystroke outline tree work
status: todo
type: task
priority: normal
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:25Z
updated_at: 2026-08-17T20:55:25Z
parent: pkm-wvvu
---

## Review findings

Frontend correctness/performance flags in `EditableBlockTree` and `outlineState`.

Each rendered block repeatedly walks ancestors to compute `focusInSubtree`, and each outline transition serializes the full tree to detect changes. Both paths run during keystroke batches.

## Acceptance criteria

- [ ] Compute the focused block ancestor chain once at the tree root and pass or derive a constant-time subtree-focus value per rendered block
- [ ] Replace full-tree `JSON.stringify` comparison with an explicit change signal from operation application or an equally reliable structural result
- [ ] Preserve render decisions, focus navigation, no-op transition identity, optimistic updates, and remote batch behavior
- [ ] Add correctness tests plus a focused complexity/performance assertion that would catch reintroduction of repeated full-tree work
- [ ] Document any changed tree/applyOps contract
