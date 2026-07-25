---
# pkm-6s7l
title: todo page
status: completed
type: feature
priority: normal
created_at: 2026-07-21T18:48:28Z
updated_at: 2026-07-25T07:48:25Z
---

Move [[TODO]] to the very top level in the sidebar, under Daily Notes and Current Work

## Checklist

- [x] Investigate how [[TODO]] page is currently reached (favourites/sidebar pages list/etc.)
- [x] Add failing test for TODO nav link in web/src/App.test.tsx
- [x] Add "TODO" nav link to left-nav in web/src/App.tsx, matching Daily Notes/Current Work styling
- [x] Remove/de-duplicate TODO from prior pinned location if it's repo config (not user DB data)
- [x] Run `cd web && E2E_PORT=8978 pnpm verify` and confirm pass
- [x] Update bean with Summary of Changes, set status to completed

## Summary of Changes

- `TODO` was previously reachable only as a regular pinned page in the
  editable "sidebar_entries" list (`SidebarNav.tsx` / `routes_sidebar.py`,
  `GET/POST/DELETE/PUT /api/sidebar`) — data the user manages via the
  sidebar's own Edit/Add/remove/reorder UI and stored in the `sidebar_entries`
  SQLite table, not repo config. Confirmed directly in the production DB
  (`sidebar_entries`): `TODO` is row id 24, `order_idx` 0 (already first in
  that list). Since that's user data rather than checked-in config, it was
  left untouched per the bean's instructions — no data migration/removal was
  performed. The new top-level link is additive; the user can still remove
  the old pinned entry themselves via the sidebar's Edit mode if they want,
  since it's now a duplicate route to the same page.
- Added a "TODO" `NavLink` in `web/src/App.tsx`'s `<nav className="left-nav">`
  directly below "Current Work", styled identically (`nav-link primary` +
  `active` on match), routing to `pagePath("TODO")` (`/page/TODO`) via the
  same `pagePath` helper `SidebarNav.tsx` uses — so it renders through the
  existing `/page/*` → `PageView` route with no server changes needed.
- TDD: added two failing tests to `web/src/App.test.tsx` first (link order/
  href/route-render, and primary+active styling), confirmed they failed
  against the old App.tsx, then implemented the nav link and confirmed both
  pass.
- Verified with `cd web && E2E_PORT=8978 pnpm verify` (typecheck, lint,
  check:fcis, coverage-enforced unit tests [1435 passed], vite build, and 33
  Playwright E2E specs) — passing. One transient E2E failure
  (`e2e/backlink-filter.spec.ts`, pkm-m4an) was seen on a couple of runs;
  reproduced identically on the pre-change base commit and cleared on retry,
  confirming it's a pre-existing, load-sensitive flake unrelated to this
  change (this session ran concurrently with other parallel worktree
  sessions also exercising `pnpm verify`).

Files changed: `web/src/App.tsx`, `web/src/App.test.tsx`,
`.beans/pkm-6s7l--todo-page.md`.
