---
# pkm-8dgu
title: Property coverage gaps for stale-batch handling
status: in-progress
type: task
priority: low
created_at: 2026-10-14T12:14:28Z
updated_at: 2026-10-14T13:12:35Z
---

Follow-up to pkm-ynze / pkm-wvac. The stale-batch rules are covered end to end by the web sync property suite (DeletePage racing offline edits, serial replay with a seen_seq mapping, the "delete wins" invariant, teeth) and by example tests (server/tests/test_stale_page_ops.py). Gaps a property run would not catch:

1. The server Hypothesis ops model (server/tests/props/test_ops_state.py, model.py, strategies.py) never draws a page delete or a seen_seq, so classify_skip(page_stale=), the stale_page plans and the stale-unlink rewrite rows are pinned only by examples.
2. No invariant notices spurious daily-note conflict entries. The chained-edit noise fixed late in pkm-ynze was found by review: convergence, serial replay and delete wins all still held while it happened. A "no conflict entry unless two devices really edited the same block concurrently" check (or a tally the gate asserts on) would have caught it.
3. Drawn texts never contain a leading attribute (`X:: v`), so pkm-4g1a's case is never drawn.
4. The stale race appears in only ~5% of sync examples (103/2100), partly because DeletePage spares the busiest page (pkm-ialr).
5. The stale-teeth scenario does not cover the orphan-edit parked-text path (a stale update_text of a block on the deleted page carrying a live link).

## Todo

- [x] Server ops model: draw page deletes and seen_seq; model staleness (server texts also draw leading attributes now)
- [ ] A conflict-noise check in the sync oracle (or ops model)
- [ ] Draw leading-attribute texts once pkm-4g1a has a rule
- [ ] Teeth: add the orphan-edit parked-text path
