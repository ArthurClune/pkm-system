---
# pkm-qd81
title: Hostile-input 500s and unbounded work on page, query and export routes
status: todo
type: bug
priority: normal
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T11:36:48Z
parent: pkm-mfd0
---

Review findings (Low, availability), table in the review report: SPA catch-all 500s on NUL / over-long components (anonymous); single-page export ((ref)) fan-out grows K^3 (279 MB from 11 KB); outline depth >= 255 makes page/block/journal 500; backlink breadcrumbs O(depth^3); IN-lists over 32,766 variables 500; /api/query 500s on deep or wide expressions; legacy deeply nested [[ makes rename/delete 500.

- [ ] Red test first, from the review probe: sec-exports/p4b_spa_exc.py, p5_amplify.py, p7_varlimit.py; sec-pages/p2_query.py, p2b_query_exc.py, p3_deep_tree.py, p3b/p3c_threshold.py, p3d_journal.py, p4_placeholders.py, p5b_brackets_legacy.py; sec-pages/p8_ancestors.py is timing, a perf case. Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [ ] SPA catch-all returns 404 for paths resolve() rejects
- [ ] Export: bound output size or ref fan-out
- [ ] Depth: cap outline depth at write time or serialise iteratively
- [ ] Chunk IN-lists
- [ ] Query parser: depth and operand limits answered with 400
- [ ] Backlink ancestors: avoid the per-row path string
- [ ] Iterative unlink/rename rewriting

## Note from the guard tests (pkm-t74a)

A symlink loop inside web_dist (`/loop1`) also answers 500: `Path.resolve()` raises RuntimeError, not ValueError or OSError. The SPA 404 fix must catch it too (sec-exports/report.md finding 3). test_spa.py's containment guard only checks the body for that path, so it will not notice the status change.
