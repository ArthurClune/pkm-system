---
# pkm-dj8u
title: Search bar block results don't jump to the matching block
status: completed
type: bug
priority: normal
created_at: 2026-08-20T12:22:57Z
updated_at: 2026-08-20T12:27:39Z
---

Selecting a block-scoped result in the top-bar search navigates to the page but lands at the top, not at the matched block. toRows() in web/src/components/SearchBar.tsx drops the block hit's uid, and go() navigates to pagePath(title) with no hash. Both destinations already support a block target: PageView honours #uid (pkm-pzdu scroll+flash) and openInSidebar(title, uid) flashes in the panel (pkm-gdi5).

- [x] Failing test: block row navigates to page#uid (main + sidebar paths)
- [x] Carry uid on block ResultRows; append #uid on navigate, pass uid to openInSidebar
- [x] Web verify (typecheck, unit coverage, e2e)

## Summary of Changes

SearchBar block rows now keep the hit's uid. go() appends #uid to the main-pane navigation (PageView scrolls+flashes via the pkm-pzdu hash contract) and passes uid to openInSidebar (pkm-gdi5 flash target). Page hits are unchanged (no hash, undefined uid). Tests: new unit tests for both paths plus a page-hit no-hash guard; full pnpm verify green (2300 unit, 54 e2e).
