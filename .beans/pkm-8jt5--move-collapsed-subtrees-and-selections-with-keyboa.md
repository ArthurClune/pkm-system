---
# pkm-8jt5
title: Unify block movement on Shift+Cmd+Arrow
status: completed
type: bug
priority: normal
created_at: 2026-07-22T09:04:05Z
updated_at: 2026-07-22T11:39:42Z
---

Unify block movement on Shift+Cmd+Arrow for focused blocks and active multi-block selections. Selected movement must work within and across parent boundaries while atomically preserving depth, hierarchy, and order; remove Option/Alt+Arrow movement.

## Checklist

- [x] Reproduce the selection shortcut failure and identify the root cause; user withdrew the collapsed-subtree report
- [x] Add failing regression tests for unified shortcut routing and depth-preserving selected-range movement
- [x] Implement the minimal shared fix while preserving single-block and drag behavior
- [x] Run focused tests and full web verification
- [x] Review, summarize, complete, commit, push, and merge with --no-ff

## Investigation and approved design

The collapsed-subtree report was withdrawn after it could not be reproduced; browser verification also confirmed that moving a collapsed parent carries its descendants. The remaining root cause is a split shortcut design: focused Shift+Cmd+Arrow uses depth-preserving subtree movement, selected Option/Alt+Arrow uses a sibling-only planner, and selected Shift+Cmd+Arrow falls into generic selection extension.

Approved design: remove Option/Alt+Arrow movement and make Shift+Cmd+Arrow the sole focused/selected move shortcut. Multi-selection movement is atomic and preserves each selected root run's absolute depth, hierarchy, and order within and across parent boundaries. Spec: `docs/superpowers/specs/2026-07-22-unified-block-move-shortcut-design.md`.

## Implementation plan

Detailed execution plan: `docs/superpowers/plans/2026-07-22-unified-block-move-shortcut.md`. The worktree baseline passed `cd web && pnpm verify` before implementation.

## Summary of Changes

Unified focused and selected block movement on Shift+Cmd+Arrow, added atomic depth-preserving planning for mixed-depth selected root runs, expanded collapsed cross-parent destinations, removed application-level Option/Alt movement, and covered pure operations, keyboard precedence, read-only behavior, optimistic batching, undo, and browser hierarchy changes.
