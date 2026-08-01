---
# pkm-vszf
title: Keep focused search inside narrow phone viewports
status: completed
type: bug
created_at: 2026-08-01T13:21:21Z
updated_at: 2026-08-01T18:53:00Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 14.

**References:** web/src/styles.css:400-407,698-710; web/src/components/SearchBar.tsx:184-196; web/src/components/TopBar.tsx:80-114

Focus forces a fixed 320px search width. With the other top-bar controls present, the input extends left of 320px and 390px viewports.

**Direction:** At the phone breakpoint, cap expansion to available space, allow the field to shrink, and retain a visible themed focus ring.

- [x] Add 320px and 390px page-route geometry tests
- [x] Make focused width responsive

## Summary of Changes

At the `@media (max-width: 600px)` phone breakpoint, `.search-field` (the
flex item wrapping the top-bar search input) now gets `min-width: 0`. Without
it, a flex item's automatic minimum size floors at its content's size — here
the focused input's fixed 320px (pkm-0wg9) — so the field could never shrink
below that, pushing it past 320/390px viewports. `min-width: 0` lets the flex
algorithm squeeze the field into whatever room the title and buttons leave;
desktop's fixed 220px/320px widths on `.top-bar-search-input` are untouched
and now just act as a cap the flex item can no longer be forced past.

Shrinking the field also loses its only focus signal at this breakpoint
(desktop signals focus by growing the field, and `.top-bar-search-input`
opts out of the shared ring for that reason, pkm-0wg9), so the phone
breakpoint re-enables `.top-bar-search-input:focus-visible`'s themed ring.

No markup changes; CSS-only.

**Tests:**
- `web/src/styles.test.ts`: pins the desktop fixed-width rules (unchanged),
  the phone `.search-field { min-width: 0; }` declaration, and the phone
  focus-ring declaration, via `mediaRulesFor`.
- `web/e2e/search-viewport.spec.ts`: sets a 320×660 and a 390×844 viewport,
  visits a real page route (so the full top bar — title, search, help,
  page menu — is on screen), focuses search, waits out the 0.15s width
  transition, and asserts the input's boundingBox stays within the
  viewport (`x >= 0`, `x + width <= viewport width`). jsdom can't lay out
  flexbox, so this is the only place that catches real overflow.

Verified: RED confirmed by stashing the `styles.css` change and re-running
`src/styles.test.ts` (both new tests failed with "Missing CSS rule for
... in @media (max-width: 600px)"); GREEN after restoring. Full
`pnpm test:unit` (117 files, 1776 tests), `pnpm typecheck`, and the full
Playwright suite (48 tests, including both new viewport tests) all pass.

Docs: `docs/architecture/frontend.md`'s focus-affordance exception list
for `.top-bar-search-input` updated to note the desktop-only growth cue and
the phone-breakpoint ring override.
