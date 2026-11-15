---
# pkm-fb5s
title: GET /api/query/records
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T18:05:27Z
parent: pkm-l79g
---

Task 6 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.


## Summary of Changes

- `GET /api/query/records?expr` (`routes_search.query_records`) returns
  `QueryRecordsPayload`: records, ranked keys, and `total` (records). Same
  parse, plan, source-block exclusion and 400 on `QueryParseError` as
  `/api/query`; no `expand`.
- `server/src/pkm/server/query_records_db.py` (Shell) reads, one statement
  per `chunk_ids` chunk each: results' parent and attribute page, line
  holders, a page's top-level and a line's direct-child `::` lines (with
  child counts), and the insert points (`page_insert_points`,
  `line_insert_points`). It then calls `build_records`.
- New row key `attribute_title`; `page_record_key`/`line_record_key` shared
  by the core and shell; `_omit_empty` takes several fields.
- Statements: 5 at 3 records, 8 at 600 (three chunked fetches gain one
  chunk past CHUNK_SIZE). Perf scenario `query/records` added to the
  backend baseline. backend.md API row added; openapi and columns.gen
  regenerated; the title-input props cover the new route.
