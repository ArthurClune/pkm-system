---
# pkm-6jyz
title: Unlink work under the write lock still grows past linear for in-limit text
status: completed
type: bug
priority: critical
created_at: 2026-10-25T17:07:34Z
updated_at: 2026-10-26T20:23:11Z
parent: pkm-mfd0
---

From the security/batch-server Task 3 round-5 re-review (2026-10-25; findings O2, O3, R1 in that branch's task-3-r5-rereview.md). Both predate the branch.

O2: a page title ending in [ is allowed. Unlinking one link to it joins the following text into a fresh link, so [[a[]] followed by [a[]] repeated takes one pass per link at depth 1: quadratic. A 40,006-character block within every limit holds the write lock 15 s on page delete and preview, and 61 s through one stale-batch op (seen_seq=0). Prod has no title ending in [ (surveyed 2026-10-25, 0 of 4,500).

O3: a delete replay builds deeply wrapped text by splicing (a client cannot send it directly; it is refused on arrival). One 256 KB op holds the lock 41 s; four ops in one batch 157 s, since each op replays the spliced text three times.

R1: comments and the planned doc text claim an unlink takes at most depth+1 passes; O2 refutes it.

- [x] Refuse titles ending in [ wherever titles ending in ] are refused (server, web mirror, parity fixture, importer)
- [x] Legacy text: cap unlink passes (measured depth + 2), reporting residual on delete and fencing what is left on the stale paths
- [x] A work budget (depth x spliced length) at the sites that judge nesting before unlinking, refusing limit / landing over_limit
- [x] Correct the depth+1 claim in comments
- [x] troubleshooting.md row(s)

## Summary of Changes

- Behaviour: titles ending in `[` are refused wherever titles ending in `]` are (server, web mirror, parity fixture, importer); the legacy unlink caps its passes (measured depth + 2), reporting the residual on delete and fencing what is left on the stale paths; a work budget MAX_UNLINK_WORK = 2 x MAX_BLOCK_TEXT_CHARS (depth x length) is judged where nesting is judged, refusing `limit` or landing `over_limit`; the depth+1 claim is corrected in comments. The budget was then extended to the whole batch: MAX_BATCH_REPLAY_WORK charges replay steps (unlink, rename-only, every exit), stale titles are found in one pass naming the titles a text links, and stale-title work is intersected with linked titles; the final fix charges a replayed step's per-title work and re-recorded rows, reads a block's rewrite rows lazily by (uid, base_hash) and charges rows read, and skips identical duplicate rows.
- Measured: O2 15 s -> 0.03 s on delete/preview and stale 60 s -> 0.005 s (400); O3 4 ops 181 s -> 1.1 s; 500-op batch ~2,100 s -> 0.9 s; rename replay steps 272.6 s -> 4.2 s; 20 stale titles 24.5 s -> 6.0 s; 500 creates x 1M deleted titles 19.4 s -> 2.2 s; K=90k titles, 500 tiny edits 28.4 s -> 0.69 s; 900k-row tiny edit 2.58 s -> 0.00 s.
- Main commits: 04122bc5, 9c00e47e, 9683a854, 18cde31a (task 13); 31cdc2df..ba282704, 238d6c50, ceb0c494, e4335c69 (batch budget, rename steps, stale titles); eba1f8f2 (C1), 793d45f9, 42b037b3, 6763fe3c (final round); 3efb879c (length(CAST AS BLOB) in place of octet_length), ef60c03a (docs qualifier). troubleshooting rows for each failure.
- Rulings: orchestrator: O2/O3 get this bean and a Task 13 on this branch (prod has 0 of 4,500 titles ending in `[`, surveyed 2026-10-25); round-1 Important fixed here (reuse the first replay, per-batch cumulative budget, ops past it land over_limit, never 4xx); B1 charged like the unlink branch; B2 one set-predicate pass recording every title the unlink asks about (an oracle shows the matched-titles design differs from the probes, mutant MH); M1 widened the reuse property to 2-3 stale titles; final review C1 fixed on this branch in a single fix wave with pkm-v0vw folded in; I-A is a doc claim plus a pre-existing cost, so the qualifier was restored and pkm-hlom filed; m-a use length(CAST(x AS BLOB)) (no SQLite version dependence); m-b drop the branch-only troubleshooting row and make replay required. Arthur 2026-10-26: revert the C1(a) narrowing (record the whole step as at 8cf2d65e), keep the per-batch cache across RecordRewrite, charge the per-step K-title work and re-recorded rows to MAX_BATCH_REPLAY_WORK (over_limit past it); fix I2 on this branch; one extra round beyond the single fix wave by Arthur's call. Arthur 2026-10-26 also accepted the perf regression ops/edit-rename-replay 25 -> 26 statements.
- Accepted consequences: replays spend the budget sooner so more land over_limit; a K=90k step cannot replay in one batch (74% of budget) and lands text_limit; a blind landing (rows cost > budget left) plains every link including live ones; dedupe is skipped past the budget; the editor has no syntax notice for a title ending in `[`.
- Follow-ups: pkm-v0vw (folded in here), pkm-hlom (move/delete subtree cost, uncharged), pkm-8w77, pkm-76sh.

Follow-up beans filed from the final review and re-reviews: pkm-hlom (subtree-sized moves and deletes cost a tiny op its subtree), pkm-8w77 (run apply_batch off the event loop), pkm-5sot (importer report prints a refused over-long title in full), pkm-qgjs (title-length check keystroke cost near the cap), pkm-8ui6 (legacy over-long titles skip the client check on drag, Unlinked Link, no-replica), pkm-yeat (title-length parity fixture lacks NBSP/combining/surrogate cases), pkm-76sh (test_no_500_upstream_props reach floor flake), pkm-7981 (ops property never reaches the over-limit landings), pkm-v3ub (editor does not pre-check forbidden title characters; unverified).
