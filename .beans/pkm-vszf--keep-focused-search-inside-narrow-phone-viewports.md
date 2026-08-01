---
# pkm-vszf
title: Keep focused search inside narrow phone viewports
status: todo
type: bug
created_at: 2026-08-01T13:21:21Z
updated_at: 2026-08-01T13:21:21Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 14.

**References:** web/src/styles.css:400-407,698-710; web/src/components/SearchBar.tsx:184-196; web/src/components/TopBar.tsx:80-114

Focus forces a fixed 320px search width. With the other top-bar controls present, the input extends left of 320px and 390px viewports.

**Direction:** At the phone breakpoint, cap expansion to available space, allow the field to shrink, and retain a visible themed focus ring.

- [ ] Add 320px and 390px page-route geometry tests
- [ ] Make focused width responsive
