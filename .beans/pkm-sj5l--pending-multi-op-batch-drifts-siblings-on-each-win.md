---
# pkm-sj5l
title: Pending multi-op batch drifts siblings on each window that lacks it
status: todo
type: bug
created_at: 2026-10-03T14:19:22Z
updated_at: 2026-10-03T14:19:22Z
parent: pkm-nws9
---

Found during the pkm-yxcs F7 diagnosis. With a batch like [move s4 0; move s4 1] pending, each changes window that does NOT contain it makes reapplyPending add +2 to the siblings' order_idx (scratch: 2→4→6→8), because keepSlot's per-op 'already placed' check fails for the first move once the second has placed the block. Transient: it heals when the batch's echo re-ships its journalled siblings after the ack. Contradicts the 'sibling order_idx drifting up per window' row in sync-recovery.md § Recovery never erases intent (corrected in pkm-yxcs's docs pass). Possible local rule: skip replaying a batch when the window re-shipped none of the rows it touches. Ruling (Arthur 2026-10-03): fix later.

- [ ] Unit reproduction
- [ ] Design and fix
