---
# pkm-n6io
title: Replay-log harness cosmetics
status: scrapped
type: task
priority: deferred
created_at: 2026-10-05T20:49:55Z
updated_at: 2026-11-11T13:34:37Z
---

Cosmetic leftovers from the pkm-j3ui review:
- [ ] server/tooling/proptest/sync_server.py: echo state typed as a bare dict (and the route return types) -- give it a TypedDict.
- [ ] web/src/outline/tree.test.ts: four 'as BlockOp' casts.
- [ ] web/src/props/outline/run.test.ts cosmetics (unspecified in the review; read the file and tidy, or drop this item).


## Reasons for Scrapping

The 'as BlockOp' casts in tree.test.ts are already gone. What remained (one bare dict in sync_server.py and an unspecified run.test.ts tidy-up) is not worth a branch. (Arthur, 2026-11-11.)
