---
# pkm-4ydx
title: offline banner blocks usage
status: completed
type: bug
priority: normal
created_at: 2026-07-22T09:03:34Z
updated_at: 2026-07-22T15:44:08Z
---

The offline banner stays at the top of the page,overlaying on UI elements including search bar etc, impeding work offline. It should sit at the top of the page pushing other elements down rather than floating over

## Checklist

- [x] Reproduce and identify the banner layout root cause
- [x] Add a failing regression test
- [x] Implement the minimal layout fix
- [x] Run required verification


## Investigation

The banner used `position: fixed`, removing it from document flow and placing it over the top bar. A failing Playwright geometry assertion confirmed the banner bottom was 27.5px while the top bar still began at y=0. The app now uses a column shell so the normal-flow banner occupies its own row above the existing horizontal layout.

## Summary of Changes

Moved offline and sync banners into a normal-flow app banner stack so they push the desktop layout down. The stack height is measured and exposed through a CSS custom property so fixed mobile chrome remains below wrapped or multiple banners and stays available while scrolling. Added a Playwright regression covering desktop top-bar clearance, mobile hamburger clearance, and fixed behavior after scrolling. Verified with `cd web && pnpm verify` (1,360 unit tests and 20 Playwright tests).
