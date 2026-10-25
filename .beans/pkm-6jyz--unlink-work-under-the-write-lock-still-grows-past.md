---
# pkm-6jyz
title: Unlink work under the write lock still grows past linear for in-limit text
status: todo
type: bug
priority: critical
created_at: 2026-10-25T17:07:34Z
updated_at: 2026-10-25T17:07:34Z
parent: pkm-mfd0
---

From the security/batch-server Task 3 round-5 re-review (2026-10-25; findings O2, O3, R1 in that branch's task-3-r5-rereview.md). Both predate the branch.

O2: a page title ending in [ is allowed. Unlinking one link to it joins the following text into a fresh link, so [[a[]] followed by [a[]] repeated takes one pass per link at depth 1: quadratic. A 40,006-character block within every limit holds the write lock 15 s on page delete and preview, and 61 s through one stale-batch op (seen_seq=0). Prod has no title ending in [ (surveyed 2026-10-25, 0 of 4,500).

O3: a delete replay builds deeply wrapped text by splicing (a client cannot send it directly; it is refused on arrival). One 256 KB op holds the lock 41 s; four ops in one batch 157 s, since each op replays the spliced text three times.

R1: comments and the planned doc text claim an unlink takes at most depth+1 passes; O2 refutes it.

- [ ] Refuse titles ending in [ wherever titles ending in ] are refused (server, web mirror, parity fixture, importer)
- [ ] Legacy text: cap unlink passes (measured depth + 2), reporting residual on delete and fencing what is left on the stale paths
- [ ] A work budget (depth x spliced length) at the sites that judge nesting before unlinking, refusing limit / landing over_limit
- [ ] Correct the depth+1 claim in comments
- [ ] troubleshooting.md row(s)
