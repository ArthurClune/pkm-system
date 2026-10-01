---
# pkm-izm4
title: Asset ref groups put a synthetic counter in BacklinkGroup.page_id
status: todo
type: bug
priority: low
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T07:44:38Z
parent: pkm-7uxw
---

`refGroups` (`web/src/views/filesCore.ts:127-141`) shapes an asset's refs for `BacklinkGroupList` and writes a synthetic counter into the contract field that otherwise always holds a real DB page id:

```ts
group = { page_id: groups.length, page_title: ref.page_title, items: [] };
```

Its comment says why: the search payload carries no page ids. The only consumer today is a React key (`components/BacklinkGroupList.tsx:21`), so nothing is broken yet. But `mergeGroups` (`components/groups.ts:6-17`) dedupes by `page_id`, so if these groups ever went through it (pagination, say), groups from different assets' refs would merge into unrelated pages. A web `PageId` brand would only flag this (`groups.length` would stop typechecking); it wouldn't choose the fix.

## Plan

- [ ] Failing test shaped like the hazard (two synthetic groups collide through `mergeGroups`), or a type-level test, whichever expresses it better
- [ ] Choose one: `refGroups` returns its own group type keyed by `page_title` (it already groups by title), with `BacklinkGroupList` accepting either; or `mergeGroups` takes its key as a parameter
- [ ] Remove the `page_id: groups.length` assignment
