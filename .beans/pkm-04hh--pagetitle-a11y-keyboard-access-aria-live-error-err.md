---
# pkm-04hh
title: 'A11y: PageTitle + linked-refs filter chips'
status: todo
type: feature
priority: normal
created_at: 2026-07-17T19:30:20Z
updated_at: 2026-07-18T17:28:17Z
---

Follow-up from pkm-g0t5 final review (a11y bundle for the click-to-edit page title):

- [ ] Title edit reachable by keyboard (h1 not focusable today — tabIndex + Enter/Space handler or a button wrapper)
- [ ] Error message announced via aria-live (and consider focus management)
- [ ] Stale rename error clears when navigating to another page (PageTitle keeps error state across title prop changes; key the component or reset on title change)

Un-scrapped 2026-07-18: broadened to absorb the filter-chip a11y follow-up from the pkm-m4an final review.

Filter chips (linked-refs filter, pkm-m4an):

[ ] Keyboard path for exclude — shift-click is the only way to exclude a chip today; keyboard users can include (Enter/Space) but never exclude
[ ] Chips expose include/exclude state to AT (aria-pressed or similar) — the included/excluded distinction is purely visual
