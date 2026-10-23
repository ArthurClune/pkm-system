---
# pkm-ec46
title: Chunk SQL IN-lists that can exceed SQLite's variable limit
status: completed
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. _block_ref_counts, _fetch_ancestors and _gather_resolution_data bind one variable per id; past 32,766 the query raises and the route answers 500. Probes: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-pages/p4_placeholders.py, docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-exports/p7_varlimit.py.

- [x] Red test from each probe
- [x] Chunk every IN-list built from an unbounded id set
- [ ] perf/check.sh backend before merge
- [x] troubleshooting.md row

## Summary of Changes

`_block_ref_counts`, `_fetch_ancestors`, `_resolve_ref_uids` (routes_pages) and
the export `_gather_resolution_data` now run each id set through
`sync_core.chunk_ids` (500 per statement) and merge the rows. Ids are deduped
first so a repeated uid cannot double a breadcrumb. Tests in
`server/tests/test_sql_variable_limit.py` use 33,000 ids. backend.md
Database section states the rule; troubleshooting.md has a row. The perf
check is left to the orchestrator before merge.
