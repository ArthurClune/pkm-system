---
# pkm-0ib0
title: replayFkCheck property rarely reaches the CHILD case
status: todo
type: bug
created_at: 2026-10-19T15:16:07Z
updated_at: 2026-10-19T15:16:07Z
---

The replayFkCheck property ("no hit implies the batch added no
foreign_key_check key", web/src/replica/replayFkCheck.test.ts) rarely
reaches the case targetedFkHit's CHILD clause exists for. With that clause
removed (`AND 0`) in web/src/replica/apply.ts, the property failed on only
1 of 6 seeds at 3000 runs (run 2811). A subtler PAGE mutant (page-has-blocks
guard restricted to order_idx > 0) was caught on 4 of 6. Always-false and
dropping the PAGE clause are caught on every seed within ~300 runs.

Only 23 of 3000 runs (0.8%) have a batch that adds a violation key at all.
The CHILD case needs FKs off plus a comma-bearing uid whose child the path
match misses.

- [ ] Label the CHILD-reaching case with fc statistics and read its rate
- [ ] Bias the generator (or add a targeted arbitrary) so CHILD is reached
  often, without dropping the other case rates
- [ ] Re-run both mutants across several seeds: each caught on every seed
- [ ] If the rates allow, reconsider numRuns 3000 (and the 30 s timeout)
