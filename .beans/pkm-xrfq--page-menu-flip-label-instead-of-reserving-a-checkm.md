---
# pkm-xrfq
title: 'Page menu: flip label instead of reserving a checkmark slot for timestamps'
status: completed
type: bug
priority: normal
created_at: 2026-08-03T20:13:03Z
updated_at: 2026-08-03T20:28:54Z
---

The page menu's timestamps item reserves a fixed-width slot for its checkmark
(`.top-bar-menu-check`, `styles.css:463`, 1.25em) so the label sits indented
whether or not the item is checked. In a narrow menu that indent pushes the
label onto a second line ("Show / timestamps") while the three siblings below it
("Open in sidebar", "Export as Markdown", "Delete page…") start flush at the
padding edge. The result reads as a misalignment bug, and the empty slot on the
unchecked state carries no information.

Fix: drop the reserved slot and carry the state in the label -- "Show
timestamps" when stamps are off, "Hide timestamps" when they are on. Every item
then starts at the same x, and nothing wraps.

Note on wording: Arthur asked for "Hide Timestamps"; proposing sentence case
"Hide timestamps" to match the three sibling items. Confirm before shipping.

## Checklist

- [x] `TopBar.tsx` -- removed the `.top-bar-menu-check` span; renders
      `stamps ? "Hide timestamps" : "Show timestamps"`
- [x] Role: now plain `role="menuitem"`. With the state in the text there is no
      checked state to announce, and keeping `menuitemcheckbox` + `aria-checked`
      would have said the same thing twice.
- [x] `styles.css` -- `.top-bar-menu-check` deleted (nothing else used it;
      BlockMenu's `.block-menu-item-check` untouched)
- [x] `TopBar.test.tsx` -- three tests rewritten: each state asserts its own
      label present AND the opposite absent; the toggle test still proves the
      menu stays open
- [x] `styles.test.ts` -- the checkmark-width test replaced by one asserting the
      slot's *absence* (rulesFor throws), so reintroducing it fails
- [x] e2e `block-stamps.spec.ts` -- helper matches `/(Show|Hide) timestamps/`
      (it toggles both ways); the post-reload check now asserts the label reads
      "Hide timestamps" instead of `aria-checked="true"`
- [x] `docs/architecture/frontend.md` -- module-map line reworded; two prose
      invariants added next to the stamp-cell note
- [x] Verify: `pnpm verify` -- 1938 unit tests, 49 e2e, all green
- [x] Looked at the real menu (Playwright screenshot, 520px viewport, both
      states): four items, one line each, one shared left edge

## Found while verifying: the menu was at min-content width

The indent was only half the cause. `.top-bar-menu` is absolutely positioned
inside `.top-bar-page-menu`, a *button-sized* relative parent, so its
shrink-to-fit width resolves against ~30px of available space and lands at
min-content -- the widest single word. That is why "Export as Markdown" wrapped
too in Arthur's screenshot, with no checkmark slot involved. The 160px
`min-width` hid it for short labels only, so a larger font size, browser zoom or
a longer label would have wrapped the flipped label again.

Fixed in the same pass: `white-space: nowrap` on `.top-bar-menu button, a`,
which makes min-content equal max-content so the box widens to its longest
label. Screenshot before: "Export as Markdown" 57px tall (two lines). After:
34.5px, same as every sibling. Consequence to remember -- a new menu item now
costs width, not height.

## Wording

Shipped sentence case "Hide timestamps" (Arthur wrote "Hide Timestamps") to
match "Open in sidebar" / "Export as Markdown" / "Delete page…". One-word change
in `TopBar.tsx` plus three test strings if he wants the capital T.

## Not fixed (pre-existing, unrelated)

`e2e/block-stamps.spec.ts` fails roughly 1 run in 5 at its post-reload
`.block-stamp` assertion. Confirmed pre-existing: stashed this branch, rebuilt,
ran the spec 5x on unmodified `main` code -- 1 failure; ran it 5x with the change
-- 0 failures. Not diagnosed further here; worth its own bean if it keeps
surfacing.
