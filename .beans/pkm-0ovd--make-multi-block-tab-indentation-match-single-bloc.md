---
# pkm-0ovd
title: Make multi-block Tab indentation match single blocks
status: in-progress
type: bug
priority: normal
created_at: 2026-07-21T14:00:14Z
updated_at: 2026-07-21T14:11:46Z
---

Make Tab and Shift-Tab apply consistent one-level indentation changes to a multi-block selection. Shift-Tab must stop the whole operation if any selected block is already at the maximum left edge; Tab must preserve the same one-level nesting constraints as single-block indentation.

## Checklist

- [x] Explore editor context and establish root cause
- [x] Clarify selection semantics and success criteria
- [x] Compare approaches and obtain design approval
- [ ] Write, self-review, commit, and obtain approval for design spec
- [ ] Write and review implementation plan
- [ ] Implement with failing tests first
- [ ] Run focused and full verification
- [ ] Review, complete bean, commit, push, and merge with --no-ff

## Investigation

Root cause: an active block selection unmounts the focused textarea and moves keyboard ownership to `EditableBlockTree`'s tree container. The textarea path maps Tab/Shift-Tab to single-block indent/outdent, but the tree selection handler exposes no equivalent branches or selection handlers. The pure edit layer also has no selection-level indent/outdent planner, so no structural operation is produced. Existing group move/delete code establishes the root-reduction and batched-op patterns.

## Confirmed semantics

- A selection spanning nesting levels moves as a structure while preserving its internal hierarchy.
- Tab and Shift-Tab are atomic: if any selected root cannot move exactly one level, the entire gesture is a no-op.
- Each successful gesture changes absolute depth by exactly one level; selected siblings must not staircase under one another.

## Related follow-up

pkm-tu3a tracks hierarchy-preserving outline paste. It will use a separate pure clipboard-forest/create-op planner; this indentation fix does not need a generic tree-diff engine.
