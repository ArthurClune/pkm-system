---
# pkm-if6k
title: Python macro option parser, parity fixture and server stripping
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T16:45:48Z
parent: pkm-l79g
---

Task 3 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.

## Summary of Changes

Added pkm.macro_options (split/format/refusal), parity dump + fixture + regen Step, backend.md row; find_query_macros now returns the expression without options (single funnel for resolve, export route and unlink). Tests in test_macro_options*.py, test_export_resolve.py, test_export_routes.py, test_unlink.py.
