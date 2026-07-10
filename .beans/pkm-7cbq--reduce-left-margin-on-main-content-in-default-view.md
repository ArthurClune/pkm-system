---
# pkm-7cbq
title: Reduce left margin on main content in default view
status: completed
type: task
priority: normal
created_at: 2026-07-10T17:50:52Z
updated_at: 2026-07-10T17:56:09Z
---

The default view has too much whitespace on the left-hand side of the main content area. Reduce it to roughly 1/3 of the current spacing.

## Acceptance criteria
- [x] Left margin/padding of main content in the default view is ~1/3 of current
- [x] Layout still looks correct at narrow and wide window widths
- [x] Web tests and typecheck pass

## Summary of Changes

The whitespace came from `.main-pane { max-width: 800px; margin: 0 auto }` centering the content in the space right of the sidebar. Both `.main-pane` and `.top-bar` (kept in lockstep so the buttons stay aligned with content) now use `margin-left: max(0px, calc((100% - 800px) / 6))` with `margin-right: auto` — exactly 1/3 of the previous left gap at every width above the 800px max-width, and 0 (padding only) below it, so narrow windows are unchanged. 336 web tests + typecheck green.
