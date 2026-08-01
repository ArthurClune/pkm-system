---
# pkm-3622
title: Guard Files pagination and select-all against stale filters
status: completed
type: bug
created_at: 2026-08-01T13:20:53Z
updated_at: 2026-08-01T13:20:53Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 7.

**References:** web/src/views/Files.tsx:100-164

reload() has a generation guard, but loadMore() and selectAll() do not. Responses started before a filter change or refresh can mix result sets, overwrite totals, and select files outside the visible filters.

**Direction:** Guard every list operation with the same generation/query key or cancellation mechanism.

- [x] Add in-flight pagination/select-all filter-change tests
- [x] Centralize request-generation handling for all Files list operations

## Summary of Changes

Extracted the generation guard already used by `reload()` into two shared
helpers, `bumpGeneration()` and `isStale()`, operating on the existing
`generation` ref. `loadMore()` and `selectAll()` now capture the generation
before their fetch(es) start and bail out (without touching `items`,
`total`, or `selected`) if the generation has moved on by the time each
response resolves — the same behaviour `reload()` already had, applied
uniformly to every Files list operation.

`selectAll()`'s `finally` still unconditionally clears `busy`: that flag is
a UI lock on the in-flight operation, not fetched data, so it must be
released even when the result itself is discarded as stale (otherwise a
stale selectAll would leave the toolbar buttons disabled forever).

Added two regression tests in `web/src/views/Files.test.tsx` using a
`deferred()` promise (existing pattern from other test files) to hold a
`loadMore`/`selectAll` request open while a filter change lands and
resolves first, then asserting the stale response is discarded: no items
mixed into the list, no total overwritten, no selection made outside the
newly visible filter, and the busy lock is released.

Files changed: `web/src/views/Files.tsx`, `web/src/views/Files.test.tsx`.
