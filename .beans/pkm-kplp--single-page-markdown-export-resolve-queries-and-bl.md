---
# pkm-kplp
title: 'Single-page markdown export: resolve queries and block refs to text'
status: completed
type: feature
created_at: 2026-07-25T12:02:10Z
updated_at: 2026-07-25T12:02:10Z
---

The end-user page export (GET /api/export/page/{title}) should resolve query blocks and ((block refs)) to their actual text, unlike the backup export (export_graph / nightly) which correctly keeps the raw query command and one-level refs. Split the rendering modes.

## Checklist

- [x] Investigate: query syntax/grammar (server query.py, web grammar/tokenize.ts, QueryBlock.tsx), block-ref rendering (BlockRef.tsx/BlockRefProvider.tsx), backup export code path (writer.py/markdown.py) to keep untouched
- [x] Design: new Core module `pkm.export.resolve` (pure), depth caps mirroring the live UI's own (BlockRef MAX_DEPTH=3, QueryBlock MAX_DEPTH=2), flat precomputed maps for cycle safety
- [x] TDD: failing core tests in `test_export_resolve.py` (nested refs, cyclic refs, query with results, empty query results, depth caps) then implement `resolve.py`
- [x] Share `QUERY_SOURCE_FILTER` via `query.py` (was private to routes_search.py) so the export route's query execution matches live `/api/query` exactly
- [x] Wire `routes_export.py`: `_gather_resolution_data` (Imperative Shell BFS gathering uid texts + query results, depth-capped) + `render_page_resolved` (Core)
- [x] Route-level integration tests in `test_export_routes.py`: nested refs, cyclic refs (terminates), query block with results, empty query results; update the old one-level-ref-resolution test to the new recursive/unwrapped expectation
- [x] Confirm backup path (`export_graph`/`render_page`) untouched: existing `test_export_writer.py` / `test_export_markdown.py` still pass unmodified
- [x] Run server pytest + pyrefly + ruff -- all green
- [x] Check openapi.json / shim_parity / web types for drift; regenerate + `pnpm verify` only if web-visible surface changed
- [x] Update `docs/architecture/backend.md`'s "Export and backup" section
- [x] Update bean: checklist complete, Summary of Changes, status completed

## Summary of Changes

**Investigation**

- Queries are Roam-flavoured `{{query: <expr>}}` / `{{[[query]]: <expr>}}`
  macros. Grammar/execution: `server/src/pkm/server/query.py`
  (`parse_query`/`plan_sql`, pure) and `routes_search.py`'s `run_query`
  (`GET /api/query`, the live endpoint `QueryBlock.tsx` hits). `expr` syntax
  is `{and|or|not: [[Page]] ...}`, nested; SQL is set ops (INTERSECT/UNION/
  EXCEPT) over the `refs` table. A block whose own text *is* a query macro
  is excluded from any query's results (`QUERY_SOURCE_FILTER`, moved from
  `routes_search.py` private to a shared constant in `query.py` since
  `routes_export.py` now needs the identical exclusion).
- Live rendering: `web/src/grammar/tokenize.ts` finds `{{query: ...}}` /
  `{{[[query]]: ...}}` via a balanced-brace scan (`scanMacro`);
  `QueryBlock.tsx` fetches `/api/query?expr=...` and renders a header +
  results grouped by page (`MAX_DEPTH = 2` guards nested queries).
  `((uid))` block refs render via `BlockRef.tsx` + `BlockRefProvider.tsx`:
  a flat uid->text map, resolved recursively (`MAX_DEPTH = 3`), so a cycle
  can't recurse forever -- it just keeps substituting the same map entry
  until the depth cap trips.

**Server**

- `server/src/pkm/export/resolve.py` (new, Functional Core): the resolved
  rendering mode for the end-user export. `find_query_macros` (Python port
  of `tokenize.ts`'s `scanMacro`/`QUERY_PREFIX`), `resolve_text` (single
  left-to-right scan substituting both `((refs))` and `{{query: ...}}`
  against precomputed maps, recursing with an incremented depth), plus
  `render_query_result` and `render_page_resolved`. Depth caps
  (`BLOCK_REF_MAX_DEPTH = 3`, `QUERY_MAX_DEPTH = 2`) mirror the live UI's
  own constants exactly. Cycle safety comes from the flat map + depth cap
  (same shape as `BlockRefProvider`'s), not per-path tracking.
- `server/src/pkm/server/query.py`: `QUERY_SOURCE_FILTER` promoted from a
  `routes_search.py`-private constant to a shared one (plain string, no
  I/O -- stays Functional Core). `routes_search.py` updated to import it.
- `server/src/pkm/server/routes_export.py`: `GET /api/export/page/{title}`
  now calls `_gather_resolution_data` (new, Imperative Shell -- a
  depth-capped, `visited`-set breadth-first fetch of every uid/query-expr
  the resolver might need, executing queries via `_run_query`, a
  same-shape copy of `routes_search.run_query`'s SQL kept local rather than
  cross-importing another routes module) and `render_page_resolved`
  instead of the old one-level `_uid_to_text` + `markdown.render_page`.
  `GET /api/export.zip` (the whole-db backup path, `export_graph`) is
  untouched -- still raw query command, one-level parens-wrapped refs.
- `server/tests/test_export_resolve.py` (new): 18 Core-level unit tests --
  macro-finding (both spellings), ref resolution (recursive, unknown-stays-
  raw, depth cap, cyclic-terminates), query rendering (grouped results,
  singular/plural count, empty results, unknown-expr-stays-raw, item text
  itself resolved, nested-query depth cap), and full-page assembly.
- `server/tests/test_export_routes.py`: 4 new route-level integration
  tests (own from-scratch DB fixtures, not the shared `conftest.py` seed,
  to avoid disturbing other test files) -- two-level-deep ref resolution,
  cyclic refs terminate, a query block resolving to real results, a query
  with no results. Updated the existing one-level-ref test to the new
  recursive/unwrapped-text expectation.
- `docs/architecture/backend.md`: split "Export and backup" into the
  backup path (unchanged) and the new single-page resolved-export
  description.
- No `openapi.json` / shim-parity / web-type drift: route signatures
  unchanged (checked via `openapi_dump` diff), nothing under `web/`
  touched, so `pnpm verify` was not required per the task instructions.

**Design notes returned to caller**

- Queries: Roam `{{query: {and|or|not: [[Page]] ...}}}` (and the
  `{{[[query]]: ...}}` spelling), executed via the existing
  `parse_query`/`plan_sql`, rendered as `Query: <expr> — N results`
  followed by a `- <page title>` / `  - <item text>` list per group (or
  `(no matching blocks)` when empty).
- Ref/query depth policy: `BLOCK_REF_MAX_DEPTH = 3`, `QUERY_MAX_DEPTH = 2`
  -- identical numbers and "shared depth counter" shape to
  `BlockRef.tsx`/`QueryBlock.tsx`, so the export matches what a live reader
  would see. Cycle guard: resolution is a flat precomputed-map lookup (not
  live re-fetching along a path), so a cyclic `((ref))` chain just
  re-substitutes the same text at increasing depth until the cap trips and
  the innermost ref/macro is left raw; the shell's gathering BFS also uses
  a `visited` set so it fetches each uid/expr at most once regardless of
  cycles.

**Verification**

- `cd server && uv run pytest -q` -- 639 passed, 95.38% coverage.
- `cd server && uv run pyrefly check` -- 0 errors.
- `cd server && uv run ruff check` -- all checks passed.
- Web `pnpm verify` not run: no files under `web/` changed (confirmed
  `openapi.json` has no diff after regenerating).

Not merged to main; not deployed, per instructions.
