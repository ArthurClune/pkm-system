---
# pkm-thee
title: Web title, BlockUid and PageId brands
status: in-progress
type: task
priority: normal
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T19:19:13Z
parent: pkm-7uxw
blocked_by:
    - pkm-1v8b
    - pkm-9km9
    - pkm-85x3
    - pkm-izm4
---

Brand titles, block uids and page ids across `web/src`. This is the largest step and can be split by directory (outline, components, replica, views). It depends on the server types (so the schema carries `x-brand` markers) and on the gen-types spike.

## Types

- **`NormalizedTitle` / `CanonicalTitle`**: minted by `normalizeRefTitle` (`grammar/scan.ts:50`), by `canonicalizeTitle` (`replica/titles.ts:52`) and by replica row reads. About 130 sites, e.g. `replica/localApi/pages.ts:35`, `replica/localOps.ts:52-83`, `replica/reconcile.ts:28`, `outline/edits.ts:80`, `contexts.ts:15`, `components/TopBar.tsx:25`. Raw URL titles (`paths.ts:15` `titleFromPathname`) stay plain `string`.
- **`BlockUid`**: minted at `uid.ts:7`, validated in `replica/localApi/router.ts:31`. About 132 sites, e.g. `outline/tree.ts:16`, `outline/edits.ts:80,415`, `outline/dnd.ts:13,30`, `components/blockRefStore.ts:17-42`, `replica/localOps.ts:58-149`.
- **`PageId` / `SidebarEntryId`**: `replica/reconcile.ts:15`, `replica/localApi/pages.ts:25`, `components/groups.ts:6`. Offline pages are negative until reconciled (same type; the sign carries meaning). Tombstones carry the id as TEXT (`replica/apply.ts:330`).

## Swap shapes this guards (every call site correct today)

- `(pageTitle, uid)` positional pairs on about 20 outline commands (`outline/edits.ts:80,143,191,245`, `outline/history.ts:23`)
- `onNavigate(pageTitle, uid)` (`components/BacklinkGroupList.tsx:16,36`), `openInSidebar(title, uid?)` (`contexts.ts:15`), `{uid, pageTitle}` (`views/EditablePage.tsx:61-64`)
- `remapLocalPage(db, localId, targetId)` (`replica/reconcile.ts:15`)

## Plan

- [x] Agree how a raw title is promoted: one function per form, no casts at call sites
- [x] Titles, by directory
- [x] `BlockUid`, by directory
- [x] `PageId` / `SidebarEntryId`
- [ ] `pnpm verify` clean per directory slice
