---
# pkm-26y7
title: 'Replica: a pull answered before an acked commit rewinds that commit''s text'
status: in-progress
type: bug
created_at: 2026-10-14T13:35:59Z
updated_at: 2026-10-14T13:35:59Z
---

Found by the pkm-8dgu conflict-noise invariant (sync property suite). A changes window the server answered before batch X committed can arrive after the client processed X's ack. `applyWindow` (web/src/replica/apply.ts) treats it as at the head (`next_since >= latest_seq`) and runs `rewind(db, "all")`, rewinding X's frozen records to their pre-images. The replica shows pre-X text until the next window, and an edit enqueued in that gap is hashed against it: a spurious "overwritten" conflict entry (and a visible flash of the old text).

Shrunk: `Nudge(A, ahead), Edit(A, upd pt_seed_3 "Proptest::"), Pull(C), Edit(A, upd pt_seed_3 "")`, seed 1199270201. Needs an overlapping pull plus a delayed commit.

## Todo

- [ ] Vitest regression beside web/src/replica reproducing the stale-window rewind
- [ ] Fix: a window is "at the head" for an acked frozen record only once latest_seq reaches that ack's seq
- [ ] proptest/check.sh web --file sync passes repeatedly (seed 1199270201 included)
- [ ] troubleshooting.md row; sync-and-offline.md note if the invariant changes
