---
# pkm-vcn6
title: improvements to file browser
status: completed
type: feature
priority: normal
created_at: 2026-07-29T20:42:50Z
updated_at: 2026-08-12T16:10:26Z
---

In the image card in image search, the refs should be clickable to give the list of refs as links. Clicking on 'described' should show the description. Clicking on an image opens in new tab: instead it should expand like in the rest of the app. 'Search files' should allow search by description text (search by filename is pretty limited use)

## Checklist

- [x] ImageOverlay extracted from AssetImage
- [x] Image thumbnails expand in-app
- [x] filesCore ref-grouping/chunking helpers
- [x] FileCardPopovers (refs + description)
- [x] Badges wired to popovers in Files.tsx
- [x] Search placeholder mentions descriptions
- [x] E2E coverage
- [x] Docs updated (frontend.md)

## Summary of Changes

Web-only; no server changes — the refs popover reuses the existing `GET /api/block-refs` batch endpoint (chunked client-side at its 50-uid cap).

- `web/src/components/ImageOverlay.tsx` (new): fullscreen overlay extracted from `AssetImage`; owns scroll lock, Escape/Tab handling, focus restore.
- `web/src/components/AssetImage.tsx`: delegates to the shared overlay.
- `web/src/views/Files.tsx`: image thumbs are now `button.file-thumb` expanding in-app via `ImageOverlay`; refs badge and described/failed status badges are buttons opening popovers; orphan/pending stay inert spans; search box copy is now "Search names & descriptions".
- `web/src/views/FileCardPopovers.tsx` (new): refs popover (grouped by page, rendered by `BacklinkGroupList`, navigates to the referencing block) and description/error popover; `BlockRefBacklinksPopover` chrome conventions (clamping, Escape/outside-mousedown, mouse/touch-only per pkm-3w2h).
- `web/src/views/filesCore.ts`: pure `refUidChunks` / `refGroups` helpers + `MISSING_BLOCK_TEXT`.
- `web/src/styles.css`: button variants for `.file-thumb` / `.file-badge`, popover text rule.
- `web/e2e/files.spec.ts`: refs-popover navigation + in-app expansion e2e (own page, corner-click per pkm-7iv7).
- `docs/architecture/frontend.md`: /files section documents card interactions and search scope.

Full `pnpm verify` green at 29d322e (typecheck, eslint, FCIS, 2067 unit tests, coverage, build, 53 Playwright).
