---
# pkm-zyd3
title: 'Block menu views: numbered list and document'
status: todo
type: feature
created_at: 2026-07-13T18:57:34Z
updated_at: 2026-07-13T18:57:34Z
---

Add persistent subtree display modes to the block right-click menu. A numbered-list view numbers the selected block's descendants; document view restores the normal document/bullet presentation.

## Acceptance Criteria

- [ ] The block right-click menu offers `View as numbered list` and `View as document`.
- [ ] Choosing numbered-list view makes every descendant in the selected block's subtree display ordered-list markers at its nesting level, rather than standard bullets or indentation alone.
- [ ] Choosing document view restores the same subtree to the normal document/bullet rendering.
- [ ] Switching views does not alter block text, parent/child relationships, ordering, or collapse state.
- [ ] The selected view is persisted, survives reload, and synchronizes to other clients through the normal operation path.
- [ ] Imported view metadata, if present, maps to the same rendering behavior.
- [ ] The active view is indicated in the context menu.
- [ ] Tests cover nested numbering, reverting to document view, persistence, optimistic updates, and remote updates.
