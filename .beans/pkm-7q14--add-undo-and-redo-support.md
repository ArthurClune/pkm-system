---
# pkm-7q14
title: Add undo and redo support
status: in-progress
type: feature
priority: normal
created_at: 2026-07-14T21:14:34Z
updated_at: 2026-07-16T17:06:53Z
---

Add undo/redo support for editing operations.

## Acceptance Criteria

- [ ] Cmd-Z undoes the most recent supported editing operation.
- [ ] Shift-Cmd-Z redoes the most recently undone operation.
- [ ] Undo and redo preserve document/block consistency across supported operations.
- [ ] Performing a new operation after undo clears the redo history as expected.
- [ ] Automated tests cover undo, redo, and redo-history invalidation.
