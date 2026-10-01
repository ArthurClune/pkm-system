---
# pkm-izm4
title: Asset ref groups put a synthetic counter in BacklinkGroup.page_id
status: completed
type: bug
priority: low
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T11:37:59Z
parent: pkm-7uxw
---

`refGroups` (`web/src/views/filesCore.ts:127-141`) shapes an asset's refs for `BacklinkGroupList` and writes a synthetic counter into the contract field that otherwise always holds a real DB page id:

```ts
group = { page_id: groups.length, page_title: ref.page_title, items: [] };
```

Its comment says why: the search payload carries no page ids. The only consumer today is a React key (`components/BacklinkGroupList.tsx:21`), so nothing is broken yet. But `mergeGroups` (`components/groups.ts:6-17`) dedupes by `page_id`, so if these groups ever went through it (pagination, say), groups from different assets' refs would merge into unrelated pages. A web `PageId` brand would only flag this (`groups.length` would stop typechecking); it wouldn't choose the fix.

## Plan

- [x] Failing test shaped like the hazard (two synthetic groups collide through `mergeGroups`), or a type-level test, whichever expresses it better
- [x] Choose one: `refGroups` returns its own group type keyed by `page_title` (it already groups by title), with `BacklinkGroupList` accepting either; or `mergeGroups` takes its key as a parameter
- [x] Remove the `page_id: groups.length` assignment

## Summary of Changes

`refGroups` (`views/filesCore.ts`) now returns its own `AssetRefGroup` type,
`{ page_title, items }`, with no `page_id` field. It used to return a
`BacklinkGroup` with a synthetic `page_id: groups.length`. Because the field is
missing, `mergeGroups`'s `page_id` generic rejects asset groups at compile
time, so the hazard can no longer be expressed. `BacklinkGroupList` accepts
either shape and keys each row on `page_id` when present, `page_title`
otherwise. `FileRefsPopover` holds `AssetRefGroup[]`.

Of the bean's two options this is the first, chosen because it makes misuse a
type error instead of a convention. No other producer or consumer of synthetic
groups exists: the implementer checked the backlinks popover and section, the
unlinked section, the batch walk and `localApi/pages`.

Tests: a type-level probe in `components/groups.test.ts` (an
`@ts-expect-error` on `mergeGroups(assetGroups, …)`, written red first), plus
the `refGroups` expectations updated. `CI=true pnpm verify` green (3028 unit
tests, 72 Playwright). `perf/check.sh` frontend: no changes against the
baseline. Docs: a note in `frontend.md` § The /files browser, and a
troubleshooting row.
