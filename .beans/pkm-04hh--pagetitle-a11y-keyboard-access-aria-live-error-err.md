---
# pkm-04hh
title: 'PageTitle a11y: keyboard access, aria-live error, error reset on nav'
status: scrapped
type: feature
priority: normal
created_at: 2026-07-17T19:30:20Z
updated_at: 2026-07-18T12:12:28Z
---

Follow-up from pkm-g0t5 final review (a11y bundle for the click-to-edit page title):

- [ ] Title edit reachable by keyboard (h1 not focusable today — tabIndex + Enter/Space handler or a button wrapper)
- [ ] Error message announced via aria-live (and consider focus management)
- [ ] Stale rename error clears when navigating to another page (PageTitle keeps error state across title prop changes; key the component or reset on title change)
