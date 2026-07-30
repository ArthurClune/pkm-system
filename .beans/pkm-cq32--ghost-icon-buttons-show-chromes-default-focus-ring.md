---
# pkm-cq32
title: Ghost icon buttons show Chrome's default focus ring, not the themed one
status: todo
type: bug
priority: normal
created_at: 2026-07-30T07:57:10Z
updated_at: 2026-07-30T14:00:01Z
---

Found by the pkm-0wg9 whole-branch review. pkm-0wg9 gave `.btn-secondary` and `.btn-danger` a themed `:focus-visible` outline (`2px solid var(--color-link)`, `outline-offset: 1px`) and `.input-control` carries the same, but the three ghost icon buttons were never included:

- `.top-bar-menu-button`
- `.sidebar-toggle-button`
- `.help-button`

They share one rule (`web/src/styles.css`, the rule that pkm-0wg9 rounded to `--radius-pill`) and have no `outline` declaration at all, so a keyboard user tabbing the top bar gets Chrome's default blue ring on these three and the app's link colour everywhere else. Inconsistent, and the blue clashes with the palette — which was the original motivation for the themed ring in pkm-0wg9.

Note these buttons deliberately carry `border: 1px solid transparent` (not `none`) so hover cannot shift layout (pkm-absu) — preserve that.

Also check the other bare `<button>` classes for the same gap while in here.

- [x] Add a themed `:focus-visible` outline to the three ghost icon buttons
- [x] Audit the remaining bare `<button>` classes for the same omission -- found 9 more (.top-bar-menu button/a, .chevron, .panel-close, .hamburger, .date-picker-header button, .date-picker-day, .block-menu-item, .empty-page, .assistant-close, .assistant-preview-toggle); all fixed the same way
- [x] Guard it in `web/src/styles.test.ts` (text-level drift guard; note `ruleFor` needs the full comma-separated selector list as one string)
- [ ] Verify by tabbing the top bar in both light and dark
