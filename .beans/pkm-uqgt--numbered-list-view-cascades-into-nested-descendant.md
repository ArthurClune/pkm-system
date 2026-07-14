---
# pkm-uqgt
title: Numbered list view cascades into nested descendants
status: completed
type: bug
priority: normal
created_at: 2026-07-14T15:33:32Z
updated_at: 2026-07-14T15:38:35Z
---

view_type: numbered on a block should number only its direct children. Because effectiveChildView returns explicit ?? inherited, blocks with null view_type inherit the ancestor's numbered mode, so grandchildren (and deeper) also render as numbered instead of defaulting to bullets.

Repro: set 'View as numbered list' on a block; indent a child under one of its numbered items -> the indented child is numbered too, should be a bullet.

- [x] Failing unit test: null-view child under numbered parent renders bullets
- [x] Fix effectiveChildView to drop inheritance (explicit ?? document)
- [x] Update BlockTree/EditableBlockTree callers + menu checked state
- [x] pnpm verify passes

## Summary of Changes

effectiveChildView(inherited, explicit) returned `explicit ?? inherited`, so a
block with view_type null under a numbered ancestor inherited numbered mode and
every nested level rendered numbers. Changed it to a single-argument
`explicit ?? "document"`: a block's view_type now styles its direct children
only, and unset blocks fall back to plain bullets. Updated both renderers
(BlockTree, EditableBlockTree) to the new signature; the block menu's checked
view now reflects the block's own setting rather than an inherited one. Tests
were rewritten to encode the direct-children-only semantics.
