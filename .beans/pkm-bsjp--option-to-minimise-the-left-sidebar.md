---
# pkm-bsjp
title: Option to minimise the left sidebar
status: completed
type: feature
priority: normal
created_at: 2026-07-10T16:36:56Z
updated_at: 2026-07-10T17:49:36Z
blocked_by:
    - pkm-j92y
---

Add a control to collapse/minimise the left sidebar to give the main pane more room, and a way to bring it back.

Depends on the top menu bar (pkm-j92y): search moves from the sidebar into the top bar, so search keeps working while the sidebar is hidden.

- [x] Toggle control (button and/or keyboard shortcut)
- [x] Collapsed state persists across reloads
- [x] Layout reflows cleanly on desktop and mobile
- [x] Search remains available (via top bar) with the sidebar hidden
- [x] Tests

## Summary of Changes

- Added a compact icon toggle ("⟨" open / "⟩" collapsed) at the left edge of
  the `TopBar`, before the search button, with `aria-label` ("Hide sidebar" /
  "Show sidebar") and `aria-expanded` reflecting whether the sidebar is
  currently shown.
- New `web/src/sidebar.ts` (Functional Core): `SidebarState` type,
  `SIDEBAR_STORAGE_KEY = "pkm:sidebar"`, `isSidebarState` guard, and
  `toggleSidebarState`, mirroring the existing `theme.ts` pattern.
- New `web/src/useSidebarCollapsed.ts` (Imperative Shell): reads/writes
  `localStorage["pkm:sidebar"]` (values `"open"`/`"collapsed"`), mirroring
  `useTheme.ts`/`useTheme`'s storage handling (defensive try/catch for
  private-mode/disabled storage).
- `App.tsx` owns the collapsed state via `useSidebarCollapsed()`, adds a
  `.collapsed` class to `.left-nav` when collapsed, and wires the toggle into
  `TopBar`.
- `TopBar.tsx` gained two required props (`sidebarCollapsed`,
  `onToggleSidebar`) and the toggle button; the existing page-menu code was
  left untouched to minimize collision with concurrent work on the same file.
- `styles.css`: `.left-nav.collapsed { display: none; }` hides the sidebar on
  desktop (the flex layout lets `.content-area` reclaim the width
  automatically); a phone-breakpoint override restores `display: flex` for
  `.collapsed` so the mobile hamburger overlay's own `.open` toggle remains
  the sole authority under 600px, as required.
- No keyboard shortcut, per the design decision (deferred to avoid
  collisions).
- Tests added/extended: `web/src/sidebar.test.ts` (pure logic),
  `web/src/components/TopBar.test.tsx` (toggle placement, label/
  aria-expanded, click wiring), `web/src/App.test.tsx` (toggle
  collapses/restores the nav + persists to localStorage, initial render
  honours a stored "collapsed" value, search stays reachable when
  collapsed).
