---
# pkm-hx2w
title: Keyboard shortcuts to move block subtrees up and down
status: todo
type: feature
created_at: 2026-07-14T21:22:43Z
updated_at: 2026-07-14T21:22:43Z
---

Add macOS keyboard shortcuts for moving the current block and its complete descendant subtree vertically within the page.

## Acceptance Criteria

- [ ] Shift-Cmd-Up moves the current block upward when a valid destination exists.
- [ ] Shift-Cmd-Down moves the current block downward when a valid destination exists.
- [ ] The current block and all of its descendants move together as one subtree.
- [ ] The moved block and every descendant preserve their hierarchy levels and parent/child relationships.
- [ ] A move is a no-op when the destination cannot retain the subtree root at its existing hierarchy level (for example, moving a level-three block to a position that would require it to become level one).
- [ ] Focus remains on the moved block after a successful move.
- [ ] Automated tests cover upward and downward moves, subtree preservation, hierarchy-level preservation, and invalid-move no-ops.
