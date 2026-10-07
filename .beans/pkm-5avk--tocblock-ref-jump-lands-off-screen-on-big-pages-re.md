---
# pkm-5avk
title: toc/block-ref jump lands off-screen on big pages; re-clicking the same entry does nothing
status: completed
type: bug
priority: normal
created_at: 2026-10-07T10:17:03Z
updated_at: 2026-10-07T10:22:33Z
---

Clicking a toc entry on a big page (AI in Research → Mathematics) scrolls the heading below the fold: useScrollFlashTarget scrolls once, then content above it keeps growing (lazily rendered PDF pages replace estimated slots, a Bluesky embed iframe resizes), and nothing re-pins the target. Separately, clicking the same entry again after scrolling away does nothing: the effect's deps are [uid, ready, root], none of which change on a same-hash navigation.

## Checklist
- [x] Failing unit tests: same-uid re-navigation re-scrolls; target re-centred on layout growth until the reader scrolls
- [x] Failing e2e in toc.spec.ts (growth above target; re-click after scrolling away)
- [x] Fix useScrollFlashTarget + PageView
- [x] Verify against the AI in Research repro (prod data copy)
- [x] Docs: frontend.md note; troubleshooting row
- [x] pnpm verify

## Summary of Changes

- useScrollFlashTarget takes { root, navigation } options. PageView passes the router location key as navigation, so a repeat click on the same #uid re-runs the jump.
- After the jump the hook observes every ancestor of the target up to its scope (body is fixed at 100% height, so observing it alone never fires) and re-centres on each resize. It releases on the first wheel/touch/key/pointer input or after PIN_QUIET_MS (2s) of quiet layout. No ResizeObserver: jump only, as before.
- Repro on a prod-data copy (AI in Research → Mathematics): before, heading at y=906 in an 800px viewport as PDF pages and a Bluesky embed grew the page by ~1800px; after, held at y=384 throughout. Second click after scrolling to top now jumps.
- Tests: hook unit tests (re-navigation, re-centre on resize, release on input/quiet/unmount, observed ancestors); two e2e tests in toc.spec.ts.
- Docs: frontend-editor.md toc paragraph, frontend.md module map, two troubleshooting rows.
