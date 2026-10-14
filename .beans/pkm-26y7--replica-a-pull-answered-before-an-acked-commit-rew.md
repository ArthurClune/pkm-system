---
# pkm-26y7
title: 'Replica: a pull answered before an acked commit rewinds that commit''s text'
status: completed
type: bug
priority: normal
created_at: 2026-10-14T13:35:59Z
updated_at: 2026-10-14T13:54:17Z
---

Found by the pkm-8dgu conflict-noise invariant (sync property suite). A changes window the server answered before batch X committed can arrive after the client processed X's ack. `applyWindow` (web/src/replica/apply.ts) treats it as at the head (`next_since >= latest_seq`) and runs `rewind(db, "all")`, rewinding X's frozen records to their pre-images. The replica shows pre-X text until the next window, and an edit enqueued in that gap is hashed against it: a spurious "overwritten" conflict entry (and a visible flash of the old text).

Shrunk: `Nudge(A, ahead), Edit(A, upd pt_seed_3 "Proptest::"), Pull(C), Edit(A, upd pt_seed_3 "")`, seed 1199270201. Needs an overlapping pull plus a delayed commit.

## Todo

- [x] Vitest regression beside web/src/replica reproducing the stale-window rewind
- [x] Fix: the worker refuses (pending-changed) any window whose latest_seq is short of an ack it holds, not only a removed row's (pendingGuard.ts); the suggested per-record head rule was not needed
- [x] proptest/check.sh web --file sync passes repeatedly (seed 1199270201 included)
- [x] troubleshooting.md row; sync-and-offline.md note if the invariant changes

## Summary of Changes

Root cause was a hole in the pending guard (`pendingSetStillCovered`), not in `applyWindow`. The pull snapshots the pending ids before its fetch; a batch queued after that snapshot and acked during the fetch left the ids unchanged, so the guard accepted a window the server answered before the batch committed, and the head window's `rewind("all")` restored the batch's pre-images. Such a window could also ship a row the batch touched at its pre-batch state, which the suggested per-record head rule would not have caught.

- `web/src/replica/pendingGuard.ts`: refuses any window whose `latest_seq` is short of any acked seq the worker holds, not only a removed row's. In memory only: no schema change, no added query.
- `web/src/replica/workerHandlers.test.ts`, `pendingGuard.test.ts`: regressions for the stale-window refusal (text stays the acked text) and for the one-refetch bound (the refusal itself prunes the held seq).
- Comments in `workerHandlers.ts` (ackedSeqs, prune, unmatched-delete forgetting) and `apply.ts` (what makes the head rewind safe).
- Docs: `sync-recovery.md` guard table and note, `sync-and-offline.md` step 8, `troubleshooting.md` row.

The bootstrap/snapshot path's analogous race is filed separately.
