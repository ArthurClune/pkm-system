---
# pkm-scgu
title: Block bullet is a tab stop, and its focus ring reads as collapsed
status: completed
type: bug
priority: normal
created_at: 2026-07-30T14:20:58Z
updated_at: 2026-07-30T14:28:22Z
---

Found while demoing pkm-9lwx. `span.bullet` in `EditableBlockTree.tsx` carries `draggable`, and Chrome puts draggable elements in the tab order, so tabbing a page lands on every block's bullet.

Two problems, the second the real one:

1. It shows Chrome's default ring, which pkm-cq32 themed everywhere else (the audit looked for `<button>` classes; this is a `<span>`).
2. `.bullet` is a 5px dot with a `4px solid transparent` border, and `.bullet.closed` signals *collapsed with hidden children* by colouring exactly that border. Chrome's focus ring on the same element is also a ring around the dot — so a keyboard-focused bullet looks like a collapsed block. State confusion, not just a palette clash.

Correction to the analysis above: the bullet is **not** accidentally focusable via `draggable`. It carries `role="button"`, `tabIndex={0}`, `aria-label="Open block menu"`, `aria-haspopup="menu"`, `aria-expanded`, and an `onKeyDown` handling Enter/Space/ContextMenu/Shift+F10 — a deliberate menu button added in `8152f22`. All three `onOpenMenu` call sites are on this span and `keyboardPolicy.ts` has no menu shortcut, so **it is the only keyboard route to the block menu** (copy block reference, numbered/document view, ...). `tabIndex={-1}` would have deleted that.

Decision (user, 2026-07-30), after that was surfaced: keep the tab stop, fix the ring properly. `.bullet:focus-visible { outline: 2px solid var(--color-link); outline-offset: 1px; }` — differs from `.closed` in colour and sits outside the border `.closed` colours, matching the `outline-offset: 1px` every other control uses.

- [x] Themed `:focus-visible` ring on `.bullet` (CSS only -- the component was left alone)
- [x] `styles.test.ts` drift guard, pinned against `.bullet.closed` so the pairing stays visible
- [x] Read-only `BlockTree` bullet checked: plain `aria-hidden` span, no `draggable`, no `tabIndex` -- not focusable, correctly untouched
- [x] Keyboard menu still works: Enter on the focused bullet opens it, 7 items
- [x] Verified live in both themes -- `rgb(194, 90, 40)` light, `rgb(232, 147, 90)` dark, screenshotted beside a collapsed bullet for contrast
