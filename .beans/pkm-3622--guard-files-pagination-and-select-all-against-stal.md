---
# pkm-3622
title: Guard Files pagination and select-all against stale filters
status: todo
type: bug
created_at: 2026-08-01T13:20:53Z
updated_at: 2026-08-01T13:20:53Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 7.

**References:** web/src/views/Files.tsx:100-164

reload() has a generation guard, but loadMore() and selectAll() do not. Responses started before a filter change or refresh can mix result sets, overwrite totals, and select files outside the visible filters.

**Direction:** Guard every list operation with the same generation/query key or cancellation mechanism.

- [ ] Add in-flight pagination/select-all filter-change tests
- [ ] Centralize request-generation handling for all Files list operations
