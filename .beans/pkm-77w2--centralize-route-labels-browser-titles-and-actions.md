---
# pkm-77w2
title: Centralize route labels, browser titles, and actions
status: completed
type: task
created_at: 2026-08-01T13:21:21Z
updated_at: 2026-08-01T15:10:00Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 13.

**References:** web/src/components/TopBar.tsx:20-29; web/src/App.tsx:179-187; title effects in web/src/views/CurrentWork.tsx, Journal.tsx, Files.tsx, Help.tsx, Settings.tsx, and PageView.tsx

Route declarations, top-bar labels, browser titles, and page-action recognition are maintained separately. /files and /settings already exist in the router but have no top-bar labels.

**Direction:** Define route metadata once and consume it from routing, TopBar, and one route-aware title effect, retaining dynamic page-title resolution for /page/*.

- [x] Add route metadata consistency coverage
- [x] Consolidate static route labels/titles/actions

## Summary of Changes

- New `web/src/routeMeta.ts` (Functional Core): `ROUTES` (every path App.tsx
  declares), `ROUTE_META` (label + browser title per static route),
  `DYNAMIC_ROUTES` (the explicit markers for `/page/*` and the not-found
  catch-all, whose label/title depend on data resolved after the route
  matches), `PAGE_ROUTE_PREFIX`, and `routeMetaFor(pathname)`.
- New `web/src/useRouteTitle.ts` (Imperative Shell): the single route-aware
  `document.title` effect, called once from `App()`. It replaces five
  near-identical per-view effects (CurrentWork, Journal, Files, Help,
  Settings). PageView.tsx keeps its own effect — its title depends on the
  loaded page's own title, not just the pathname.
- `TopBar.tsx`'s top-bar label now comes from `routeMetaFor(pathname)?.label`
  instead of a chain of `pathname === "..."` checks; `/files` and `/settings`
  gain top-bar labels as a natural consequence (previously missing). The
  page-action ("…") menu's route recognition now uses the shared
  `PAGE_ROUTE_PREFIX` constant instead of a locally hardcoded `"/page/"`.
- `App.tsx`'s `<Routes>` paths and the relevant `NavLink`/`Link` targets
  (Daily Notes, Current Work, Files, Settings, NotFound's "Go to Daily
  Notes") now read from `ROUTES` instead of hardcoded string literals.
- Added a consistency test (`routeMeta.test.ts`) asserting every path in
  `ROUTES` has either a `ROUTE_META` entry or is listed in `DYNAMIC_ROUTES`,
  and never both — so a newly declared route can't silently fall through
  with no label/title and no acknowledgement that it's dynamic.
- Added `useRouteTitle.test.tsx` covering all five static routes, `/page/*`
  (title untouched), the not-found catch-all (title untouched, matching
  prior behaviour), and re-navigation between routes.
- Added TopBar tests for the new `/files` and `/settings` labels.
- `Help.test.tsx` and `Settings.test.tsx` dropped their `document.title`
  assertions (that responsibility moved out of the view); coverage for it
  now lives in `useRouteTitle.test.tsx`.
- `docs/architecture/frontend.md` updated: module map entry for
  `routeMeta.ts`, and the Views/navigation section explains the
  centralization and the `/page/*` exception.

All web unit tests (1772), typecheck, lint, `check:fcis`, and
`test:coverage` pass.
