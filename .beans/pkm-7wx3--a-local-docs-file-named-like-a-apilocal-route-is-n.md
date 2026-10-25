---
# pkm-7wx3
title: A local-docs file named like a /api/local route is not served
status: in-progress
type: bug
priority: normal
created_at: 2026-10-25T00:43:56Z
updated_at: 2026-10-25T00:43:56Z
---

Property finding (2026-10-25, during pkm-g2w9 gates): test_local_index_props.py::test_index_lists_the_visible_files_and_each_is_served drew a local-docs file named 'check' at the root; the index lists it but GET /api/local/check answers the route (status 200 vs 503 expected / not the file). Any root file whose name equals a fixed route under /api/local/ (check, …) is shadowed. Reproduces at 7fc78225 with the saved .hypothesis example. Standing ruling: fix what properties find.

- [x] Shrunk example as a pytest unit test in server/tests/
- [x] Decide product bug vs wrong property (route namespace collision): fix so every listed file is servable, or the index stops listing shadowed names
- [x] troubleshooting.md row

## Summary of Changes

Product bug, not a wrong property: the index lists every visible file, and
stored notes link files as `/api/local/<path>`, so a fixed route under that
prefix shadowed the root file of the same name. The link checker moved from
`/api/local/check` to `/api/local-check`, beside `/api/local-index`; every
path under `/api/local/` is now a file. Callers updated: `PkmClient.local_check`
(`pkm local check`); the web and MCP never called it. `openapi.json` and
`types.d.ts` regenerated. `test_check_wins_over_a_file_named_check` (which
pinned the old reservation) is replaced by
`test_a_root_file_named_check_is_served` and
`test_an_evicted_root_file_named_check_is_503` (the shrunk example). Docs:
files-and-assets.md § Local documents states the rule, backend.md API table,
SECURITY.md, troubleshooting row.
