---
# pkm-sj5l
title: Pending multi-op batch drifts siblings on each window that lacks it
status: todo
type: bug
priority: normal
created_at: 2026-10-03T14:19:22Z
updated_at: 2026-10-04T19:16:26Z
parent: pkm-nws9
---

Found during the pkm-yxcs F7 diagnosis. With a batch like [move s4 0; move s4 1] pending, each changes window that does NOT contain it makes reapplyPending add +2 to the siblings' order_idx (scratch: 2→4→6→8), because keepSlot's per-op 'already placed' check fails for the first move once the second has placed the block. Transient: it heals when the batch's echo re-ships its journalled siblings after the ack. Contradicts the 'sibling order_idx drifting up per window' row in sync-recovery.md § Recovery never erases intent (corrected in pkm-yxcs's docs pass). Possible local rule: skip replaying a batch when the window re-shipped none of the rows it touches. Ruling (Arthur 2026-10-03): fix later.

- [ ] Unit reproduction
- [ ] Design and fix

Note 2026-10-04 (pkm-dbr1 merged on its branch): the effect ledger records every per-window keepSlot shift, so when the server applied the batch to another group the accumulated drift is now reverted at settle; when it applied to the same group the echo re-ships the siblings as before. The drift while the batch is pending is unchanged. The ledger names exactly the rows a pending batch touched, which a 'skip a replay when the window re-shipped none of its rows' fix could use.
