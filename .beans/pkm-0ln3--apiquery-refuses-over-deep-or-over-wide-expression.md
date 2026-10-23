---
# pkm-0ln3
title: /api/query refuses over-deep or over-wide expressions with 400
status: completed
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. Deep nesting or many operands in a query expression make /api/query 500 (recursion / work). The same limit applies to {{query}} in export. Probes: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-pages/p2_query.py, p2b_query_exc.py.

- [x] Red test from the probes
- [x] Parser enforces a nesting-depth and an operand-count limit; the route answers 400 naming the limit
- [x] {{query}} in export and in rendering handles the same refusal without a 500
- [x] backend.md API row / troubleshooting.md row

## Summary of Changes

`parse_query` counts depth as it descends and page operands across the whole
expression, refusing past `MAX_QUERY_DEPTH` (32) and `MAX_QUERY_OPERANDS` (200)
with a `QueryParseError` naming the limit. `/api/query` already mapped that to
400; the export `_run_query` already left a refused macro as raw text. With 200
operands and `expand=true` the outer compound has at most 200 terms (each
expansion is a subquery), well under SQLite's 500. Tests in test_query.py and
test_export_routes.py. backend.md API row and a troubleshooting row added.
