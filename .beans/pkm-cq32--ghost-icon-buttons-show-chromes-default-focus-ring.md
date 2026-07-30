---
# pkm-cq32
title: Ghost icon buttons show Chrome's default focus ring, not the themed one
status: completed
type: bug
priority: normal
created_at: 2026-07-30T07:57:10Z
updated_at: 2026-07-30T14:07:25Z
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
- [x] Verify by tabbing the top bar in both light and dark -- done live in both themes, see below


## Verified live 2026-07-30

Tabbed the top bar and left nav on a scratch server in both themes. Every stop reports `outline: 2px solid` in `--color-link` (`rgb(194, 90, 40)` light, `rgb(232, 147, 90)` dark); the only exception is `.top-bar-search-input`, whose `outline: none` is deliberate (its wrapper carries the affordance). Screenshots checked for clipping in both themes.

Two amendments to the stylesheet audit, both from driving the running app rather than reading the CSS:

**Added `.nav-link`** — the audit could not see this one, and it was the biggest instance of the bug. The class sits on both the `<a>` destinations and the `<button>` controls in the left nav, which are the app's **first eight tab stops**; all eight were showing Chrome's blue ring. One rule themes the whole nav.

**Removed the two date-picker rings** the audit added. `DatePickerPopup` is mouse-only by design (pkm-rw6w): its buttons `preventDefault` on mousedown so they never take focus, and Tab inside a block indents rather than moving focus — the rings were unreachable. Replaced with a comment plus a test asserting their absence, so a later audit does not add them back.

Not in scope, tracked separately: ordinary content anchors (`a.page-link`, the classless `.page-title > a`) still get Chrome's default ring. That is a links question, not a controls one.
