---
# pkm-69sl
title: cursor position
status: in-progress
type: feature
priority: normal
created_at: 2026-07-22T15:00:11Z
updated_at: 2026-07-22T15:44:50Z
---

When clicking into a block, the cursor should be placed at the end of line (ready for user input) not the start

## Design and implementation checklist

- [x] Explore project context and recent changes
- [x] Clarify cursor placement semantics
- [x] Compare implementation approaches and approve design
- [x] Write and review design spec
- [x] Write implementation plan
- [x] Add a failing regression test
- [x] Implement the minimal fix
- [x] Run required verification
- [ ] Commit, push, and complete bean

## Clarified acceptance criteria

For every non-empty block, first pointer focus and cross-block ArrowUp/ArrowDown navigation place the caret at the destination block text end. Empty blocks remain at cursor 0.

## Design

Approved design recorded in `docs/superpowers/specs/2026-07-22-pkm-69sl-cursor-position-design.md`.

## Implementation Plan

Plan recorded in `docs/superpowers/plans/2026-07-22-pkm-69sl-cursor-position.md`.

## Summary of Changes

- Changed vertical cross-block navigation to place the caret at the destination block text end.
- Preserved ArrowLeft destination-end and ArrowRight destination-start behavior.
- Added integration coverage for vertical and horizontal boundary-arrow caret placement.
- Verified with focused editor tests and the complete `cd web && pnpm verify` suite (1,360 unit tests and 19 Playwright tests passed).
