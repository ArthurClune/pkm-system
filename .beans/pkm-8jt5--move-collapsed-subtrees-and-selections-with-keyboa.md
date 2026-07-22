---
# pkm-8jt5
title: Unify block movement on Shift+Cmd+Arrow
status: in-progress
type: bug
priority: normal
created_at: 2026-07-22T09:04:05Z
updated_at: 2026-07-22T09:24:48Z
---

Unify block movement on Shift+Cmd+Arrow for focused blocks and active multi-block selections. Selected movement must work within and across parent boundaries while atomically preserving depth, hierarchy, and order; remove Option/Alt+Arrow movement.

## Checklist

- [x] Reproduce the selection shortcut failure and identify the root cause; user withdrew the collapsed-subtree report
- [ ] Add failing regression tests for unified shortcut routing and depth-preserving selected-range movement
- [ ] Implement the minimal shared fix while preserving single-block and drag behavior
- [ ] Run focused tests and full web verification
- [ ] Review, summarize, complete, commit, push, and merge with --no-ff

## Investigation and approved design

The collapsed-subtree report was withdrawn after it could not be reproduced; browser verification also confirmed that moving a collapsed parent carries its descendants. The remaining root cause is a split shortcut design: focused Shift+Cmd+Arrow uses depth-preserving subtree movement, selected Option/Alt+Arrow uses a sibling-only planner, and selected Shift+Cmd+Arrow falls into generic selection extension.

Approved design: remove Option/Alt+Arrow movement and make Shift+Cmd+Arrow the sole focused/selected move shortcut. Multi-selection movement is atomic and preserves each selected root run's absolute depth, hierarchy, and order within and across parent boundaries. Spec: `docs/superpowers/specs/2026-07-22-unified-block-move-shortcut-design.md`.
