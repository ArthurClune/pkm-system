---
# pkm-0wg9
title: 'Modernise control styling: buttons, selects, inputs feel blocky'
status: completed
type: feature
priority: normal
created_at: 2026-07-29T18:53:12Z
updated_at: 2026-07-29T21:43:11Z
---

Follow-up to pkm-mrru. The control tokens read as blocky: --radius-control is 4px
on ~30px-tall controls, every control carries a full-strength 1px --color-border-
input box (so a toolbar becomes a row of equal boxes), fills are flat with no
hover transition, all actions have the same visual weight, and buttons show
Chrome's default blue focus ring instead of a themed one. Goal: make controls
feel modern and calm without a redesign — token-level changes only, consistent in
light and dark.

## Summary of Changes

1. `--radius-pill: 999px` and `--radius-field: 7px` were added, splitting the one
   control radius into an action radius and a field radius. `--radius-control`
   stayed 4px because `.inline-code`, `.block-row`, `.block-ref:hover`,
   `.math-error`, `.file-thumb` and `.file-badge` share it — those are not
   controls and should not become pills.
2. `--color-error` is text-only; `--color-error-fill` is the button fill. In dark
   the text-tuned `#ff6b6b` reads as bright coral behind white text (the pill
   shape amplifies it), so the fill token is a deep `#a83a3a` there and stays
   `#c23030` in light. `--color-error` keeps its own job: error text and the
   failed badge.
3. The search look is one shared `.search-field` / `.search-field-icon` /
   `.search-field-input` class group that the top bar and `/files` both compose,
   rather than two lookalikes that can drift. The top bar keeps only what is
   genuinely its own: the 220px→320px focus growth and the right-hand room for
   the ⌘U hint chip.
4. Fields joined `.input-control` by className instead of restating its colours
   per context — `.nav-sidebar-add input`, `.assistant-input textarea`,
   `.composer textarea` and the assistant's model select. Those bespoke rules
   now carry layout only, and a test asserts they declare no background, border
   or border-radius.
5. `.block-input` is deliberately excluded from the field family — it is a
   writing surface, not a form field — and a test guards that it gains no field
   chrome.

Buttons also became pills (`padding: 5px 14px`, a hover border-colour shift and,
for `.btn-secondary`/`.btn-danger`, a themed `:focus-visible` outline in
`var(--color-link)` instead of Chrome's blue). The three top-bar ghost icon
buttons (`.top-bar-menu-button`, `.sidebar-toggle-button`, `.help-button`) round
to `--radius-pill` so their hover chip is circular, but carry no
`:focus-visible` rule of their own and still fall through to Chrome's default
outline. `.assistant-input .btn-secondary { align-self: flex-end; }` stops Send
stretching to the textarea's height as a tall lozenge.

Verified against the running app in both light and dark at 1440px and 375px:
the two searches are pixel-identical apart from the top bar's chip padding, the
dark Delete fills `#a83a3a` (not coral), Send is a 35px pill against a 59px
textarea, the focus ring is `--color-link` in both themes (`#c25a28` light,
`#e8935a` dark), and the `/files` toolbar wraps with no horizontal overflow at
375px. `pnpm verify` passes: 114 unit files / 1661 tests, 97.34% statements,
131 FCIS modules clean, bundle budget OK, 46 Playwright specs.
