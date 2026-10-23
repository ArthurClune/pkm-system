---
# pkm-0ln3
title: /api/query refuses over-deep or over-wide expressions with 400
status: todo
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. Deep nesting or many operands in a query expression make /api/query 500 (recursion / work). The same limit applies to {{query}} in export. Probes: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-pages/p2_query.py, p2b_query_exc.py.

- [ ] Red test from the probes
- [ ] Parser enforces a nesting-depth and an operand-count limit; the route answers 400 naming the limit
- [ ] {{query}} in export and in rendering handles the same refusal without a 500
- [ ] backend.md API row / troubleshooting.md row
