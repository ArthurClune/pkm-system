---
# pkm-q89w
title: Fix multi-select move and deletion
status: todo
type: bug
created_at: 2026-07-14T21:14:34Z
updated_at: 2026-07-14T21:14:34Z
---

Multi-block selection is only partially functional: moving a selection moves only the first selected block, and selected blocks cannot be deleted as a set.

## Acceptance Criteria

- [ ] Moving a multi-block selection moves every selected block while preserving their intended order.
- [ ] Deleting a multi-block selection deletes all selected blocks.
- [ ] Deleting more than 5 blocks requires explicit user confirmation before deletion proceeds.
- [ ] Deleting 5 or fewer selected blocks does not require the large-deletion confirmation.
- [ ] Automated tests cover multi-block move, multi-block deletion, and the confirmation threshold.
