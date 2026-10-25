---
# pkm-eovh
title: Page delete unlink costs O(depth^3) on deep legacy nesting and holds the write lock
status: scrapped
type: bug
priority: low
created_at: 2026-10-23T19:16:36Z
updated_at: 2026-10-25T03:41:50Z
parent: pkm-mfd0
---

From the pkm-lbj1 review (2026-10-23). unlink_title_refs peels one nesting layer per pass, and each pass re-slices and re-judges every opened run, so unlinking costs O(n*depth) per pass x depth passes: 4.2 s at depth 1,200, 28.5 s at 2,400 ("[["*d + "Deep" + "]]"*d). DELETE /api/page runs it under begin_immediate(), so every /api/ops write from every device waits that long; delete-preview ties up a worker.

Reach: peeling needs outer titles that become the target once inner links unlink, i.e. refs holding [[ or #, which the ops guard refuses, so only rows written before the guard can peel. The deepest [[ nesting in prod on 2026-10-23 was 2 (57,931 blocks), so nothing at risk today.

Related (authenticated CPU): rewrite_effects runs unlink_stale_refs once per stale title and the client sets seen_seq; a 500-op batch of 40 KB guard-accepted nested text ("[[a//"*n...) costs ~500 x (1 + stale titles) x 0.7 s. Belongs with request-size limits.

- [ ] Compute the peel fixpoint in one pass, innermost first (equivalence test against the current loop)
- [ ] Bound time spent under begin_immediate() for a page delete
- [ ] troubleshooting.md row

## Reasons for Scrapping

Re-judged after pkm-gc3n/pkm-bppf (2026-10-25). Every write path now refuses [[ nested past 32 (MAX_LINK_NESTING), and server-made rewrites may never make a row deeper, so the O(depth^3) unlink is bounded by depth 32 for any row written from now on (microseconds). Its remaining reach is rows stored before the limit; prod's deepest nesting is 2 (2026-10-23/24 surveys), so nothing at risk. Page delete's other unbounded allocation (inline copies before the limit judge) is tracked separately as pkm-49rh.
