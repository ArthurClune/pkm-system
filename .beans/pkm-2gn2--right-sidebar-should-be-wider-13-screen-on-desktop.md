---
# pkm-2gn2
title: Right sidebar should be wider (1/3 screen on desktop)
status: completed
type: feature
priority: normal
created_at: 2026-07-10T12:50:47Z
updated_at: 2026-07-10T13:01:07Z
---

On desktop viewports the right sidebar should take up one third of the screen width. Currently it is narrower than that.

## Summary of Changes

- `web/src/styles.css`: desktop `.sidebar` width changed from fixed `340px` to `33.333%` of the app flex container (spans the full viewport), so the right sidebar is 1/3 of the screen on desktop.
- The <=900px overlay media query now pins the overlay back to `width: 340px` so tablet overlay behaviour is unchanged (1/3 of a narrow screen would be unusably thin). <=600px full-width rule unchanged.
- Verified in the running app (scratch backend + vite on a test port): sidebar measures exactly 1/3 at 1440px and 1920px viewports, 340px fixed overlay at 800px, full-width at 500px. Web tests (272) and typecheck pass.
