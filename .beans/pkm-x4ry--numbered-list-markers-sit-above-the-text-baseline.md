---
# pkm-x4ry
title: Numbered-list markers sit above the text baseline
status: completed
type: bug
priority: normal
created_at: 2026-10-20T18:19:34Z
updated_at: 2026-10-20T18:23:01Z
---

On the iPad (PWA and Safari) the numerals of a numbered-list view sit higher than, and smaller than, the block text beside them. .bullet.numbered inherits align-self: flex-start from .bullet, so the 13px numeral is pinned to the top of a row that aligns on the 15px text baseline.

- [x] Reproduce: measure numeral vs text baseline
- [x] Failing test
- [x] Fix
- [x] Verify on iPad WebKit (Playwright WebKit; not yet on a real iPad)
- [x] Docs/troubleshooting row

## Summary of Changes

`.bullet.numbered` now takes `align-self: baseline`, so the numeral joins the row's baseline alignment instead of the dot bullet's flex-start. Measured in Chromium and Playwright WebKit with the real styles.css: numeral and text baselines were 2px apart on a plain row and 7px beside an h2; now equal, unfocused and focused (the textarea's baseline is its first line in both engines). styles.test.ts pins the declaration; troubleshooting row added.
