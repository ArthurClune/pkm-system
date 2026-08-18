---
# pkm-byig
title: Share backend query execution and page grouping
status: in-progress
type: task
priority: normal
tags:
    - review
    - backend
created_at: 2026-08-17T20:55:21Z
updated_at: 2026-08-17T20:55:21Z
parent: pkm-wvvu
---

## Review findings

Backend A3 and A4. Search and export routes duplicate execution of a query plan, source filtering, counts, and grouping, while three routes repeat the same rows-by-page loop.

## Acceptance criteria

- [ ] Put transport-neutral query-plan execution and grouped-result construction in the query/core layer rather than importing route internals
- [ ] Reuse the shared execution path from search and export while preserving counts, source filtering, ordering, and result shapes
- [ ] Add or reuse one `group_by_page` helper for search queries, todos, and unlinked references where their row contracts match
- [ ] Keep deliberately different route-specific shaping visible rather than forcing it through an over-general abstraction
- [ ] Add parity/regression tests for search and export results and update backend architecture documentation
