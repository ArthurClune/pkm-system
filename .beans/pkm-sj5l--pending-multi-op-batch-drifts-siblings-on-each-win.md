---
# pkm-sj5l
title: Pending multi-op batch drifts siblings on each window that lacks it
status: completed
type: bug
priority: normal
created_at: 2026-10-03T14:19:22Z
updated_at: 2026-10-05T19:25:20Z
parent: pkm-nws9
---

Found during the pkm-yxcs F7 diagnosis. With a batch like [move s4 0; move s4 1] pending, each changes window that does NOT contain it makes reapplyPending add +2 to the siblings' order_idx (scratch: 2→4→6→8), because keepSlot's per-op 'already placed' check fails for the first move once the second has placed the block. Transient: it heals when the batch's echo re-ships its journalled siblings after the ack. Contradicts the 'sibling order_idx drifting up per window' row in sync-recovery.md § Recovery never erases intent (corrected in pkm-yxcs's docs pass). Possible local rule: skip replaying a batch when the window re-shipped none of the rows it touches. Ruling (Arthur 2026-10-03): fix later.

- [x] Unit reproduction
- [x] Design and fix

Note 2026-10-04 (pkm-dbr1 merged on its branch): the effect ledger records every per-window keepSlot shift, so when the server applied the batch to another group the accumulated drift is now reverted at settle; when it applied to the same group the echo re-ships the siblings as before. The drift while the batch is pending is unchanged. The ledger names exactly the rows a pending batch touched, which a 'skip a replay when the window re-shipped none of its rows' fix could use.

Note 2026-10-05 (Arthur): folded into pkm-j3ui. j3ui compares the replica's optimistic state with the server's, which surfaces any user-reachable form of this drift (or the wider "a later op disturbs an earlier op's slot" shape). Editor commands emit at most one move per block per batch, and the queue does not coalesce batches, so only the sync property's raw-op batches reach it today. Fix whatever j3ui finds: findings get fixed, not tolerated.

## Summary of Changes

Fixed by the replica replay rebase inside pkm-j3ui (plan docs/superpowers/plans/2026-10-05-replica-replay-rebase.md). The effect ledger and keepSlot are gone: every feed window rewinds pending batches from a pre-image replay log (web/src/replica/replayLog.ts, rewind.ts) before the server's rows land, then replays each as a first apply, so a batch moving one block twice no longer drifts its siblings. Pinned by replay.test.ts ("a batch moving one block twice, over two windows that lack it") and by the op divergence property's exact check R. Docs: sync-recovery.md § The replay log; troubleshooting row keyed to pkm-j3ui, pkm-sj5l.
