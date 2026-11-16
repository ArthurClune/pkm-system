---
# pkm-qd81
title: Hostile-input 500s and unbounded work on page, query and export routes
status: scrapped
type: bug
priority: normal
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-11-16T10:20:48Z
parent: pkm-mfd0
---

Review findings (Low, availability), table in the review report: SPA catch-all 500s on NUL / over-long components (anonymous); single-page export ((ref)) fan-out grows K^3 (279 MB from 11 KB); outline depth >= 255 makes page/block/journal 500; backlink breadcrumbs O(depth^3); IN-lists over 32,766 variables 500; /api/query 500s on deep or wide expressions; legacy deeply nested [[ makes rename/delete 500.

- [ ] Red test first, reproducing the review's finding.
- [ ] SPA catch-all returns 404 for paths resolve() rejects
- [ ] Export: bound output size or ref fan-out
- [ ] Depth: cap outline depth at write time or serialise iteratively
- [ ] Chunk IN-lists
- [ ] Query parser: depth and operand limits answered with 400
- [ ] Backlink ancestors: avoid the per-row path string
- [ ] Iterative unlink/rename rewriting

## Note from the guard tests (pkm-t74a)

A symlink loop inside web_dist (`/loop1`) also answers 500: `Path.resolve()` raises RuntimeError on Python 3.12, not ValueError or OSError (3.13+ no longer raises on a loop; requires-python is >=3.12). The SPA 404 fix must catch it too (sec-exports/report.md finding 3). test_spa.py's containment guard only checks the body for that path, so it will not notice the status change.

## Reasons for Scrapping

Split into one bean per item (2026-10-23): pkm-xrvv SPA 404, pkm-ec46 IN-list chunking, pkm-0ln3 query limits, pkm-lbj1 iterative [[ rewrite, pkm-2kwd outline depth, pkm-8bga export fan-out, pkm-85jq breadcrumbs.
