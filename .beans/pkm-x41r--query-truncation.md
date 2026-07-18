---
# pkm-x41r
title: query truncation
status: completed
type: feature
priority: normal
created_at: 2026-07-18T17:35:52Z
updated_at: 2026-07-18T18:56:42Z
---

A large query (some return >70 results) truncates with a "show more" button. The show more button doesn't work, but actually we always want to render the full results of the query and remove the "show more"

## Checklist

- [x] Confirm the truncation root cause and affected code paths
- [x] Add a regression test that fails before the fix
- [x] Render all query results and remove the show-more behavior
- [x] Remove orphaned truncation code and references
- [x] Run required verification and review the diff
- [x] Commit and push the completed fix

## Summary of Changes

- Removed pagination parameters and SQL limits from `/api/query`.
- Simplified `QueryBlock` to render complete result sets from one request with no Show more control.
- Added server and web regressions for large result sets, regenerated API artifacts, removed pagination-only tests/code, and passed required verification.
