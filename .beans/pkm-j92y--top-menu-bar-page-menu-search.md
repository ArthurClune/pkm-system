---
# pkm-j92y
title: 'Top menu bar: page menu + search'
status: completed
type: feature
priority: normal
created_at: 2026-07-10T16:45:59Z
updated_at: 2026-07-10T17:41:33Z
---

Add a menu bar along the top of the page view. This is the anchor for two other pieces of work:

- The page-level menu (with actions like Delete, see pkm-ruvz) lives here.
- The search bar moves here from the left sidebar, so search still works when the sidebar is minimised (pkm-bsjp).

- [x] Top menu bar layout on the page view (desktop and mobile)
- [x] Page menu ('...' style) with a home for page actions
- [x] Move search bar from the left sidebar into the top bar
- [x] Remove/adjust the sidebar search entry accordingly
- [x] Tests

## Summary of Changes

Added `web/src/components/TopBar.tsx` (+ `TopBar.test.tsx`, 7 tests), a new
menu bar rendered in `App.tsx` above `<main className="main-pane">`, wrapped
together with it in a new `.content-area` flex-column div (a sibling of
`.left-nav` and the right `.sidebar` inside `.app`) so it spans the top of the
main content on both desktop and mobile.

Contents:
- A "Search" button that calls an `onSearchClick` prop; `App` still owns
  `searchOpen` state and the Cmd/Ctrl-U shortcut, unchanged.
- A "…" page menu, shown only when the route matches `/page/*` (derived via
  `useLocation` + `titleFromPathname`). It's a small `role="menu"` dropdown
  with one `menuitem`, "Open in sidebar", which calls `openInSidebar(title)`
  from `SidebarContext`. Closes on: picking the action, outside mousedown,
  Escape, and route change. Button has `aria-haspopup="menu"` /
  `aria-expanded`.

Removed the "Search" button from the left nav in `App.tsx` (search now lives
only in the top bar); added/adjusted tests in `App.test.tsx` covering the
click-driven search-open path and the page-menu "Open in sidebar" action
end-to-end (stacks the page into the right sidebar).

Styling: new `.top-bar`, `.top-bar-search-button`, `.top-bar-page-menu`,
`.top-bar-menu-button`, `.top-bar-menu` rules in `styles.css`, using only
existing `--color-*` custom properties (no hard-coded colors), so it matches
both themes. `.top-bar` and `.main-pane` share the same `max-width: 800px` +
`32px`/`16px` horizontal padding so their content lines up. On mobile
(<=600px) reduced `.main-pane`'s old `padding-top: 48px` (reserved for the
fixed hamburger) down to the desktop `24px`, since the top bar's own height
now provides equivalent clearance above the hamburger — a minor, low-risk
deviation from "touch only what's needed" made to avoid doubled whitespace.

Verification: `pnpm test -- --run` → 41 files / 303 tests passed (up from 294
before this change). `pnpm typecheck` → clean, no errors.
