---
# pkm-qd81
title: Hostile-input 500s and unbounded work on page, query and export routes
status: todo
type: bug
priority: normal
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T10:56:19Z
parent: pkm-mfd0
---

Review findings (Low, availability), table in the review report: SPA catch-all 500s on NUL / over-long components (anonymous); single-page export ((ref)) fan-out grows K^3 (279 MB from 11 KB); outline depth >= 255 makes page/block/journal 500; backlink breadcrumbs O(depth^3); IN-lists over 32,766 variables 500; /api/query 500s on deep or wide expressions; legacy deeply nested [[ makes rename/delete 500.

- [ ] SPA catch-all returns 404 for paths resolve() rejects
- [ ] Export: bound output size or ref fan-out
- [ ] Depth: cap outline depth at write time or serialise iteratively
- [ ] Chunk IN-lists
- [ ] Query parser: depth and operand limits answered with 400
- [ ] Backlink ancestors: avoid the per-row path string
- [ ] Iterative unlink/rename rewriting
