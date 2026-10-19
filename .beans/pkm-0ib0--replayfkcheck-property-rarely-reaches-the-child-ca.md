---
# pkm-0ib0
title: replayFkCheck property rarely reaches the CHILD case
status: completed
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

- [x] Label the CHILD-reaching case with fc statistics and read its rate
- [x] Bias the generator (or add a targeted arbitrary) so CHILD is reached
  often, without dropping the other case rates
- [x] Re-run both mutants across several seeds: each caught on every seed
- [x] If the rates allow, reconsider numRuns 3000 (and the 30 s timeout)

## Summary of Changes

The bean's guess was half right: CHILD is reached by a NULL-uid child and by
a comma uid. The row check refuses comma uids, but it runs only in test mode,
so the first round (checked rows) saw only the NULL case. The property now
opens its DB with `checkRows: false`, as the production worker runs.

Minimal scenario per clause:

- CHILD: FKs off; block P; a delete of P in the batch; a child subtreeUids
  skips. NULL case: a create with a NULL uid under P (this batch or an earlier
  one), since `instr(path, NULL)` is NULL. Comma case: P `x,u_aaaaa2` with
  child `u_aaaaa2`, whose uid is inside P's path. The child dangles with a new
  key; its own uid is never recorded, so only P's record shows it.
- PAGE: a block on a page with no row (page 9, or page 4 without pageD), then
  a create under it. The new block inherits the missing page, takes a fresh
  rowid (a new key) and only the recorded page shows it. All blocks on the page
  at one order_idx is what the order_idx > 0 mutant misses.

The generator now draws one of three scenarios (random, CHILD case, PAGE case),
the two targeted ones prepended to a random scenario.

| rate (3000 runs) | before | after |
|---|---|---|
| batch adds a key | 16-22 (0.5-0.7%) | ~1425 (47%) |
| CHILD clause alone produces the hit | 0 | NULL child ~300 (10%), comma child ~510 (17%) |
| PAGE clause alone produces the hit | 16-22 | ~580 (19%) |
| fksOff / dangling baseline | 50% / 50% | 66% / 67% |

Ghost refs, comma-uid ops, NULL-uid ops and the shared batch id come from the
random third, which is still 1000 draws at 3000 runs.

Teeth (final generator, 10 seeds, 101-110, failing run index per seed):

| mutant | indexes |
|---|---|
| always false | 4 2 1 2 2 3 1 1 1 1 |
| drop PAGE | 5 2 11 2 8 3 1 3 9 1 |
| drop CHILD (`AND 0`) | 4 3 1 10 2 6 3 1 1 11 |
| PAGE guard needs order_idx > 0 | 13 10 15 8 8 53 10 20 9 3 |
| CHILD child needs order_idx = 0 | 8 18 1 16 2 6 3 1 1 11 |
| PAGE only for page id <= 3 | 5 2 11 2 8 3 1 3 9 1 |
| CHILD only for NULL children | 11 6 1 10 7 6 3 1 1 11 |
| CHILD only for non-NULL children | 4 3 4 16 2 8 34 2 6 15 |

numRuns lowered 3000 -> 1000 (worst index 53, margin about twenty; the random
third keeps 330 draws). Timeout lowered 30 s -> 10 s: 0.7 s alone, 1.1 s under
coverage.

Also corrected the CHILD description in apply.ts and sync-recovery.md (NULL
uid and comma uid, both reachable in production). Random draws alone reach the comma child in 1 of 3000 runs.
