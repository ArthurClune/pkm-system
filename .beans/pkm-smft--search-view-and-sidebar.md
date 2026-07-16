---
# pkm-smft
title: Search view and sidebar
status: completed
type: feature
priority: normal
created_at: 2026-07-15T20:43:10Z
updated_at: 2026-07-16T16:20:22Z
---

In the results view from a search, shift-click or shift-enter should open the chosen result in the sidebar not the main page (exactly like shift-clink on a link does)

## Summary of Changes

`SearchBar.tsx` now consumes `SidebarContext` and threads the shift-key state through the row-selection path (`go(row, sidebar)`). Both entry points — the result row's `onClick` and the Enter branch of `onKeyDown` — pass `e.shiftKey`. For page and block-snippet rows, shift closes the dropdown (same `cancel()` as normal) and calls `openInSidebar(row.title)` instead of `navigate(...)`; block rows carry their containing page's title, so the containing page opens. The synthetic create-page row is unaffected by the shift flag — it always creates the page and navigates, since a not-yet-existing page isn't "a chosen result".

Added 4 tests to `SearchBar.test.tsx` covering shift+Enter on a page hit, shift+click on a result row, shift+Enter on a block-snippet row (opens the containing page), and shift+Enter on the create row (unchanged create+navigate behavior). All existing tests continue to pass unchanged. Full `pnpm verify` (typecheck, lint, FCIS check, unit tests w/ coverage, build, Playwright E2E) passes.
