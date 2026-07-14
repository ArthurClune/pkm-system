---
# pkm-nn7o
title: Sidebar primary links (Daily Notes, Current Work) always accent-coloured
status: completed
type: bug
priority: high
created_at: 2026-07-14T20:29:09Z
updated_at: 2026-07-14T20:32:40Z
parent: pkm-heod
---

pkm-1eaj muted all nav links with accent only on the active route. Once pkm-h49t added "Current Work" next to "Daily Notes", the two primary links now swap between orange and grey depending on route. User wants both always highlighted; the muted+active treatment stays for the pinned-pages list below the divider.

- [x] Add a `primary` variant to .nav-link, always --color-accent
- [x] Apply to Daily Notes + Current Work NavLinks in App.tsx
- [x] Tests: styles.test.ts rule + App.test.tsx class assertion
- [x] Visual check both routes, both themes

## Summary of Changes

- `.nav-link.primary` always `--color-accent`; applied to the Daily Notes and Current Work NavLinks (they keep the active class too, which is now purely informational).
- Red-first tests: App.test.tsx asserts both links carry `primary` on /current-work; styles.test.ts asserts the rule.
- Verified computed colour #ec6f35 on both links on both routes; pnpm verify green.
