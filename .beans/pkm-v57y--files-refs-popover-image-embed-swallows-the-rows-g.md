---
# pkm-v57y
title: 'files refs popover: image embed swallows the row''s go-to-block click'
status: completed
type: bug
priority: normal
created_at: 2026-08-12T16:36:13Z
updated_at: 2026-08-12T16:41:23Z
---

pkm-vcn6 follow-up. The refs popover row IS a navigation target (/page/<title>#<uid>, scroll+flash via the PageView hash effect), but the row renders the referencing block through InlineSegments, so an image-embed block renders a live AssetImage whose expand trigger fills the row and stopPropagation()s — the user can only expand the image or hit the page-title link (top of page). Fix (agreed with Arthur): render media inert inside the refs popover rows via an InertMediaContext read by AssetImage; cap thumb height in popover rows; e2e clicks the image itself to pin navigation.

## Summary of Changes

- `web/src/contexts.ts` — new `InertMediaContext` (boolean, default `false`), read by any renderer that wants to skip its interactive-expansion affordance inside a navigation-target row.
- `web/src/components/AssetImage.tsx` — reads `InertMediaContext` via `useContext`; when true and the src is an uploaded `/assets/` image, renders the plain inline `<img>` instead of wrapping it in the `asset-image-trigger` button (no expand overlay, no `stopPropagation()`).
- `web/src/views/FileCardPopovers.tsx` — `FileRefsPopover` wraps its `<BacklinkGroupList>` in `<InertMediaContext.Provider value={true}>`, so every referencing-block row it renders is fully click-to-navigate.
- `web/src/styles.css` — `.block-ref-popover .asset-image { max-height: 80px; width: auto; }` caps thumbnail size now that the image is inert decoration within the row.
- `web/e2e/files.spec.ts` — the popover-navigation e2e now clicks the embedded image itself (`.backlink-item img`) rather than a corner of the row, directly pinning the inert-media behavior.
- Tests: `web/src/components/AssetImage.test.tsx` and `web/src/views/FileCardPopovers.test.tsx` gained coverage for the inert-context render path and image-embed-block navigation.
- `docs/architecture/frontend.md` — one sentence added to the `/files` browser section noting `InertMediaContext`.

Web-only change; no server/API changes. `pnpm verify` (typecheck, lint, FCIS, unit+coverage, build, Playwright) is fully green.
