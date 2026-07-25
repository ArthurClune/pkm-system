---
# pkm-57mo
title: page width
status: completed
type: feature
priority: normal
created_at: 2026-07-22T18:47:51Z
updated_at: 2026-07-25T00:00:00Z
---


When the sidebar isn't open (left/right/both) the center pane should expand into the window, leaving a reasonable margin on both sides

## Checklist

- [x] Investigate current layout in web/src/App.tsx and CSS (center pane max-width, sidebar classes)
- [x] Design CSS approach: scale center pane max-width based on left-collapsed / right-absent state
- [x] Implement className/state wiring in App.tsx if needed
- [x] Unit test any new state->className logic in App.test.tsx
- [x] Verify phone/narrow navOpen overlay layout unaffected
- [x] Add/verify E2E assertion for center pane width in different sidebar states
- [x] Run `cd web && E2E_PORT=8977 pnpm verify` and confirm pass
- [x] Update bean: summary of changes, mark completed

## Summary of Changes

- `web/src/App.tsx`: derived `rightSidebarOpen = stack.length > 0 && !sidebarHidden` (was an
  inline JSX condition, now also drives layout) and applied two modifier classes to the
  `.app` container: `nav-collapsed` (mirrors the existing left-nav `collapsed` state) and
  `no-sidebar` (when the right sidebar isn't rendered). `.app` was previously a bare
  `"app"` className.
- `web/src/styles.css`: `.content-area`'s `--pane-width`/`--pane-left` custom properties
  (already consumed by `.main-pane` and `.top-bar`) now vary by combination instead of
  being fixed at `min(860px, 100% - 32px)` always:
  - both open (baseline, unchanged): `min(860px, 100% - 32px)`, lean-left toward the
    sidebar.
  - left nav collapsed only: `min(1040px, 100% - 48px)`, still lean-left (the sidebar
    anchor still applies).
  - right sidebar absent only: `min(1160px, 100% - 64px)`, `--pane-left: auto` so the pane
    centers (no sidebar left to lean toward).
  - both gone: `min(1320px, 100% - 96px)`, centered — the widest case. Expressed as
    `.app.nav-collapsed.no-sidebar .content-area`, which by specificity always wins over
    the two single-class rules regardless of source order.
  - The phone breakpoint (`@media max-width: 600px`) already overrides `.main-pane`'s
    width/margin unconditionally, so the new vars have no effect there — `navOpen` overlay
    behaviour is untouched. The 900px tablet breakpoint (where `.sidebar` becomes a fixed
    overlay) is unaffected in practice too, since the `min()` caps are already bounded by
    the viewport there.
- `web/src/App.test.tsx`: 5 new unit tests asserting the `nav-collapsed`/`no-sidebar`
  className logic on `.app` across the toggle/stack/hide interactions (default state,
  opening/closing the stacked sidebar, Cmd-/ hiding it, collapsing/restoring the left nav,
  and both together).
- `web/e2e/page-width.spec.ts` (new): measures `.main-pane`'s bounding-box width across all
  four left-nav x right-sidebar combinations on a real page and asserts the pane widens
  monotonically as space frees up (not pinned to exact pixel caps, which are a CSS
  implementation detail).

## Verification

`cd web && E2E_PORT=8977 pnpm verify` — passing:
- `tsc` (typecheck): clean
- `eslint src tooling`: clean
- `check:fcis`: clean
- `vitest run --coverage`: 99 test files / 1438 tests passed (incl. 5 new App.test.tsx cases)
- `vite build`: OK, PWA precache budget OK
- Playwright e2e (`tooling/runPlaywright.mjs`, port 8977): 34/34 passed (incl. new
  `page-width.spec.ts`)

Noted but out of scope: an unrelated pre-existing e2e flake
(`backlink-filter.spec.ts`, a `waitForText` timeout) surfaced on one run and a similarly
unrelated flake reproduced independently on `ref-open.spec.ts` — both pass on rerun and are
consistent with previously-tracked infra flakiness (offline replica / OPFS access-handle
races), not caused by this change.
