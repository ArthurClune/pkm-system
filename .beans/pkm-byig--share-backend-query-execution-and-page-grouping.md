---
# pkm-byig
title: Share backend query execution and page grouping
status: completed
type: task
priority: normal
tags:
    - review
    - backend
created_at: 2026-08-17T20:55:21Z
updated_at: 2026-08-18T18:34:47Z
parent: pkm-wvvu
---

## Review findings

Backend A3 and A4. Search and export routes duplicate execution of a query plan, source filtering, counts, and grouping, while three routes repeat the same rows-by-page loop.

## Acceptance criteria

- [x] Put transport-neutral query-plan execution and grouped-result construction in the query/core layer rather than importing route internals
- [x] Reuse the shared execution path from search and export while preserving counts, source filtering, ordering, and result shapes
- [x] Add or reuse one `group_by_page` helper for search queries, todos, and unlinked references where their row contracts match
- [x] Keep deliberately different route-specific shaping visible rather than forcing it through an over-general abstraction
- [x] Add parity/regression tests for search and export results and update backend architecture documentation

## Summary of Changes

- New `server/src/pkm/server/query_exec.py` (Imperative Shell): `count_matches`
  and `execute_plan` run a `query.py` plan. It owns the query-source exclusion
  filter (moved out of `query.py`, which now only parses and plans) and the
  `ORDER BY p.title, b.uid` row order. `QueryMatches.total` is counted from the
  plan rather than taken from `len(rows)`, so a caller that ever limits rows
  still reports the full match count.
- `server/src/pkm/server/backlinks.py` -> `grouping.py`, gaining
  `group_by_page(rows)` for rows of `uid, text, page_id, page_title`. It
  replaces the identical loop in `/api/query`, `/api/todos` and
  `GET /api/unlinked`. `group_backlinks` keeps its own loop -- its
  rows name the page `src_page_*` and its items carry breadcrumbs -- with the
  module docstring saying why.
- `routes_export._run_query` now calls `execute_plan` + `group_by_page` and
  reshapes the groups into its own immutable `QueryResultGroup`/`QueryResultItem`
  types at the call site; the "kept as its own copy" comment is gone.
- Tests: `server/tests/test_query_parity.py` pins /api/query and the resolved
  export over one graph (total, ref_counts, group order by page title, item
  order, exclusion of both `{{query:` and `{{[[query]]:` source blocks);
  `server/tests/test_grouping.py` covers the pure helpers.
- Docs: `docs/architecture/backend.md` module map (new `query_exec.py` row,
  `backlinks.py` -> `grouping.py`, `query.py` role narrowed to parsing +
  planning), the breadcrumbs note, and the export section's query bullet;
  `docs/architecture/cli-and-mcp.md` file name.

No route contract changed: same query params, response models, shapes and
ordering, so no openapi regen.

Verification: `uv run pytest -q` 1509 passed, coverage 97.12% (>= 95% gate);
`uv run pyrefly check` 0 errors; `uv run ruff check` clean.
