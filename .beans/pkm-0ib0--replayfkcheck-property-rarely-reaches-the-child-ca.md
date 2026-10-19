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

The bean's guess was wrong: the CHILD clause is not about a comma uid. A comma
uid cannot reach it, because every select of a comma uid fails the BlockUid row
check, so the delete throws and rolls back. The real case is a NULL-uid child.

Minimal scenario per clause:

- CHILD: FKs off; block P; a create with a NULL uid under P (this batch or an
  earlier one); a delete of P in the batch. subtreeUids' `instr(path, NULL)`
  is NULL, so the child is skipped and dangles with a new key. The child's own
  uid is never recorded, so only P's record shows it.
- PAGE: a block on a page with no row (page 9, or page 4 without pageD), then
  a create under it. The new block inherits the missing page, takes a fresh
  rowid (a new key) and only the recorded page shows it. All blocks on the page
  at one order_idx is what the order_idx > 0 mutant misses.

The generator now draws one of three scenarios (random, CHILD case, PAGE case),
the two targeted ones prepended to a random scenario.

| rate (3000 runs) | before | after |
|---|---|---|
| batch adds a key | 16-22 (0.5-0.7%) | ~1460 (48%) |
| CHILD clause alone produces the hit | 0 | ~830-860 (28%) |
| PAGE clause alone produces the hit | 16-22 | ~590-595 (20%) |
| fksOff / dangling baseline | 50% / 50% | 66% / 67% |

Ghost refs, comma-uid ops, NULL-uid ops and the shared batch id come from the
random third, which is still 1000 draws at 3000 runs.

Teeth (10 seeds, 101-110, failing run index per seed):

| mutant | indexes |
|---|---|
| always false | 2 3 1 2 2 3 1 1 1 1 |
| drop PAGE | 5 5 11 2 8 3 1 3 17 1 |
| drop CHILD (`AND 0`) | 2 3 1 10 2 6 2 1 6 11 |
| PAGE guard needs order_idx > 0 | 13 10 15 8 8 53 10 20 34 3 |
| CHILD child needs order_idx = 0 | 2 15 1 16 2 6 2 1 7 11 |
| PAGE only for page id <= 3 | 5 5 11 2 8 3 1 3 17 1 |

numRuns lowered 3000 -> 1000 (worst index 53, margin about twenty; the random
third keeps 330 draws). Timeout lowered 30 s -> 10 s: 0.7 s alone, 1.1 s under
coverage.

Also corrected the CHILD description in apply.ts and sync-recovery.md (NULL
uid, not a comma uid).
