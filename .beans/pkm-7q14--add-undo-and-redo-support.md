---
# pkm-7q14
title: Add undo and redo support
status: completed
type: feature
priority: normal
created_at: 2026-07-14T21:14:34Z
updated_at: 2026-07-16T18:01:37Z
---

Add undo/redo support for editing operations.

## Acceptance Criteria

- [x] Cmd-Z undoes the most recent supported editing operation.
- [x] Shift-Cmd-Z redoes the most recently undone operation.
- [x] Undo and redo preserve document/block consistency across supported operations.
- [x] Performing a new operation after undo clears the redo history as expected.
- [x] Automated tests cover undo, redo, and redo-history invalidation.

## Summary of Changes

Global per-tab undo/redo (Cmd-Z / Shift-Cmd-Z) over inverse op batches:
`history.ts` (pure inversion + stacks), `undoManager.ts` (singleton dispatch
through sync.enqueue + outline sessions), keyboardPolicy decisions, useOutline
recording, and window-level keys. Collapse is view state (never undone);
delete-undo recreates whole subtrees. Spec:
docs/superpowers/specs/2026-07-16-undo-redo-design.md
