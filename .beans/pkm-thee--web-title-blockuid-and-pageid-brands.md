---
# pkm-thee
title: Web title, BlockUid and PageId brands
status: completed
type: task
priority: normal
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T19:39:24Z
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
- [x] `pnpm verify` clean per directory slice

## Summary of Changes

- **Brands.** `BlockUid`, `PageId`, `SidebarEntryId`, `NormalizedTitle` and `CanonicalTitle` are now `brand()`ed on the server, so they reach the web as branded generated types. `CanonicalTitle` has its own `brand()`. The wire format is unchanged: the openapi diff adds only `x-brand` markers.
- **Web mints:**
  - `newUid` (with `newRawUid` for `ClientId` / `BatchId`) and `ids.ts` `parseBlockUid`, which the URL hash and the local API's uid parameters go through;
  - the block-ref and hashtag tokens, and `normalizeRefTitle`;
  - `replica/meta.ts` `canonicalTitle` / `titleReader`, which mirror the server's `sync_meta` and read the flag once per reader;
  - `titleForDate` / `dailyTitle`;
  - the SQLite row mappers;
  - the tombstone dispatch, per kind.
- **Signatures narrowed:**
  - outline commands take `(pageTitle: CanonicalTitle, uid: BlockUid)`, as do `useOutline` and `EditablePage`;
  - `remapLocalPage` takes a named `{ localId, targetId }`;
  - `parkTakenTitles` / `assertNoParkedTitles` tie their table to the id type through `TitledTableFor<Id>`;
  - a parked placeholder is its own `ParkedTitle` type.
- **Bug fixed (reproduced first).** `EditableSidebarPanel` keyed `<EditablePage>` by the requested title. A sidebar opened under a non-canonical title therefore missed remote ops and sent its own ops with the raw title. It now uses `payload.page.title`. There is a troubleshooting row for it.
- **Deviations:**
  - outline session keys stay `string`, because the page loader opens a session before any payload exists;
  - server response title annotations are mostly generator-only, because routes return plain dicts.
- **Verification:**
  - server: pytest 2287 passed; pyrefly 0 errors, 11 suppressed, 7 warnings; ruff clean;
  - web: `pnpm verify` green, with 3092 unit and 72 e2e tests;
  - perf: no changes on backend or frontend.
- **Final Opus review:** merge after minors. 18 production swap probes are rejected, and all mint points are honest. The minor findings are fixed.
- **Follow-up:** pkm-z2qa (low priority). A non-canonical requested title runs two outline sessions, so the resync causality guard is bypassed. This predates the branch on PageView.
