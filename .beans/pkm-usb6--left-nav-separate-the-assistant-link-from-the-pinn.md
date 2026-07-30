---
# pkm-usb6
title: 'Left nav: separate the Assistant link from the pinned pages'
status: completed
type: task
priority: normal
created_at: 2026-07-30T11:01:25Z
updated_at: 2026-07-30T11:06:47Z
---

The left sidebar has a divider/spacer between the top section (Daily Notes / Current Work / TODO / theme toggle) and the pinned-pages block -- it comes from .nav-sidebar-entries' border-top + 8px margin/padding.

There was no matching separator below the pinned pages, so the Assistant link ran straight on from the user's pinned entries.

- [x] Style test asserting the Assistant link carries the same border-top + spacing as .nav-sidebar-entries
- [x] Apply the separator class in App.tsx + styles.css
- [x] pnpm verify green

## Summary of Changes

New `.nav-section-start` rule (`web/src/styles.css`): `border-top: 1px solid var(--color-border); padding-top: 12px`, applied to the Assistant button in `web/src/App.tsx`. The pinned list now reads as the user's own block, fenced by a matching rule top and bottom.

The 8px above the rule comes free from `.left-nav`'s flex gap, so only the padding below it is declared. 12px = that 8px plus the 4px `.nav-link` already pads, which puts the Assistant text the same distance below its rule as the first pinned entry sits below the upper one. The rule is declared after `.nav-link` so its `padding-top` wins the equal-specificity tie.

Tests: `styles.test.ts` asserts both rules use the same border token and the 12px padding; `App.test.tsx` asserts the Assistant button carries the class.

Verified in the running app at 1280x800, light and dark: the two rules are symmetric around the pinned pages. With no pinned pages the upper rule is absent (it belongs to the entry list) and a single rule sits below Edit -- no doubled or orphaned line.
