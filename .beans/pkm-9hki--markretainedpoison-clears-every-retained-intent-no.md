---
# pkm-9hki
title: markRetainedPoison clears every retained intent, not only the ones it marked
status: in-progress
type: bug
priority: low
created_at: 2026-11-12T17:04:41Z
updated_at: 2026-11-12T19:36:21Z
---

markRetainedPoison (web/src/sync/opQueue.ts) iterates a snapshot of poisonMarkIntents, then clears the whole list (poisonMarkIntents = [] and poisonStore.write([])). Two overlapping calls over different batches let the first to finish erase the second's intent from memory and localStorage. If the second then fails to mark that intent, onPoisonMarkFailed raises a Retry that re-marks nothing, and the poison claim stays until Discard or a reload.

No current path is known to reach it: the drain's in-flight POST and a recovery's leased POST reject the same (oldest) row, and beforePost stops a lease once poison is claimed. Found by the whole-branch review of pkm-3ono.

## Fix
Remove only the snapshot's intents by key (id + batch_id), and write the remainder to the store.

- [x] Unit test: two overlapping markRetainedPoison calls over different batches keep the later intent
- [x] Remove by key
- [x] sync-recovery.md § A batch the server rejects if the rule changes
