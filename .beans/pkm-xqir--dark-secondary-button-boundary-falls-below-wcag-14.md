---
# pkm-xqir
title: Dark secondary button boundary falls below WCAG 1.4.11 contrast
status: todo
type: bug
created_at: 2026-07-30T07:57:22Z
updated_at: 2026-07-30T07:57:22Z
---

Flagged by the pkm-0wg9 whole-branch review as a measured, deliberate aesthetic trade-off worth revisiting — not a regression pkm-0wg9 created, but one it deepened.

pkm-0wg9 lightened `.btn-secondary`'s border from `--color-border-input` to `--color-border`:
- light: `#c8d5dc` -> `#dbe4e8`
- dark: `#3a4552` -> `#2f3944`

In dark, the button's boundary against a `.main-pane`/panel surface (`#20262c`) drops from 1.56:1 to **1.30:1**, and its own fill (`#1c2126`) is only 1.06:1 against that surface. So a dark secondary button is identified almost entirely by its label. WCAG 1.4.11 (non-text contrast) wants 3:1 for component boundaries.

The lighter border is what makes a toolbar stop reading as a row of equal boxes in light mode, so a blanket revert would undo the point of pkm-0wg9. A dark-only `border-color: var(--color-border-input)` override in the two dark theme blocks would keep the light improvement and restore the dark boundary — worth trying first.

- [ ] Decide the approach (dark-only override vs a new dedicated border token)
- [ ] Measure the resulting contrast ratio against panel and page surfaces
- [ ] Check the same surfaces for `.btn-danger` and `.input-control`
- [ ] Guard the chosen values in `web/src/styles.test.ts`
- [ ] Verify live in dark mode
