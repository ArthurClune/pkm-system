---
# pkm-vcn6
title: improvements to file browser
status: in-progress
type: feature
priority: normal
created_at: 2026-07-29T20:42:50Z
updated_at: 2026-08-12T15:33:46Z
---

In the image card in image search, the refs should be clickable to give the list of refs as links. Clicking on 'described' should show the description. Clicking on an image opens in new tab: instead it should expand like in the rest of the app. 'Search files' should allow search by description text (search by filename is pretty limited use)

## Checklist

- [x] ImageOverlay extracted from AssetImage
- [x] Image thumbnails expand in-app
- [x] filesCore ref-grouping/chunking helpers
- [x] FileCardPopovers (refs + description)
- [x] Badges wired to popovers in Files.tsx
- [x] Search placeholder mentions descriptions
- [ ] E2E coverage
- [ ] Docs updated (frontend.md)
