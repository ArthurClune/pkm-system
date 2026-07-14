---
# pkm-absu
title: Top bar cohesion
status: completed
type: feature
priority: normal
created_at: 2026-07-14T20:06:28Z
updated_at: 2026-07-14T20:49:27Z
parent: pkm-heod
---

The sidebar-toggle button floats alone top-left with the search box far right — reads as two orphaned controls rather than a bar.

- [x] Show current page title / date range in the top bar
- [x] Style search as a rounded pill with a leading icon and a ⌘U hint inside
- [x] Consistent ghost styling for top-bar buttons (no borders until hover)
- [x] Check phone breakpoint (<600px) still works with hamburger overlay

## Summary of Changes

Top bar gains a context label (`.top-bar-title`: page title, Daily Notes, or Current Work) that doubles as the left/right flex spacer; search input became a rounded pill with a platform-aware ⌘U/Ctrl+U kbd hint that hides on focus or text; toggle+kebab share one ghost rule; phone top bar gets 52px left padding to clear the fixed hamburger (verified at 390px width).
