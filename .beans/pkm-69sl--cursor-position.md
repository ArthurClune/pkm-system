---
# pkm-69sl
title: cursor position
status: in-progress
type: feature
priority: normal
created_at: 2026-07-22T15:00:11Z
updated_at: 2026-07-22T15:40:45Z
---

When clicking into a block, the cursor should be placed at the end of line (ready for user input) not the start

## Design and implementation checklist

- [x] Explore project context and recent changes
- [x] Clarify cursor placement semantics
- [x] Compare implementation approaches and approve design
- [x] Write and review design spec
- [x] Write implementation plan
- [ ] Add a failing regression test
- [ ] Implement the minimal fix
- [ ] Run required verification
- [ ] Commit, push, and complete bean

## Clarified acceptance criteria

For every non-empty block, first pointer focus and cross-block ArrowUp/ArrowDown navigation place the caret at the destination block text end. Empty blocks remain at cursor 0.

## Design

Approved design recorded in `docs/superpowers/specs/2026-07-22-pkm-69sl-cursor-position-design.md`.

## Implementation Plan

Plan recorded in `docs/superpowers/plans/2026-07-22-pkm-69sl-cursor-position.md`.
