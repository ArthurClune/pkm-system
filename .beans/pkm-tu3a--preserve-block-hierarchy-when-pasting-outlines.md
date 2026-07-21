---
# pkm-tu3a
title: Preserve block hierarchy when pasting outlines
status: todo
type: feature
priority: normal
created_at: 2026-07-21T14:11:36Z
updated_at: 2026-07-21T14:11:46Z
---

When pasted text contains outline indentation, parse it into a temporary forest and create blocks whose parent relationships preserve the clipboard's relative hierarchy. Anchor the resulting forest at the paste location.

## Relationship

Related to pkm-0ovd, which adds atomic one-level indentation for existing multi-block selections. This paste feature should use a separate pure clipboard-to-create-ops planner rather than requiring a generic existing-tree depth/diff engine. It may reuse small tree/ordering helpers established by pkm-0ovd, but is not blocked on a generic transform abstraction.

## Checklist

- [ ] Brainstorm clipboard formats and indentation rules
- [ ] Design a pure clipboard forest parser and create-op planner
- [ ] Implement with unit tests for nested and malformed indentation
- [ ] Add integration and end-to-end paste coverage
- [ ] Run full verification
