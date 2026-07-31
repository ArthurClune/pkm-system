---
# pkm-l4z8
title: Make clickable headings keyboard-accessible (page title, unlinked refs)
status: completed
type: bug
priority: high
created_at: 2026-07-31T16:05:42Z
updated_at: 2026-07-31T19:38:32Z
parent: pkm-6phf
---

Finding 5 of epic pkm-6phf (web review).

**References:** web/src/components/PageTitle.tsx:62-67; web/src/components/UnlinkedSection.tsx:127-130

Page-title editing and Unlinked References expansion use onClick on non-focusable headings, leaving those interactions unavailable from the keyboard.

**Direction:** Prefer semantic buttons inside the heading structure, including aria-expanded for collapsible content, with themed :focus-visible styling.

- [x] Add keyboard interaction tests for title editing and Unlinked References
- [x] Replace mouse-only heading interactions with semantic controls

## Summary of Changes

Both headings now wrap their label in a real `<button>` nested inside the
`<h1>`/`<h2>`, so the document outline is unchanged but the control is
natively focusable and Enter/Space-activatable:

- `PageTitle.tsx`: `<button class="page-title-edit">` replaces the `<h1
  onClick>` when the title is editable; daily-note titles (non-editable) keep
  a plain `<h1>` with no button.
- `UnlinkedSection.tsx`: `<button class="section-toggle" aria-expanded>`
  replaces the `<h2 onClick>`; the decorative chevron is marked
  `aria-hidden`.
- `styles.css`: two new chrome-free control classes, `.page-title-edit` and
  `.section-toggle`. `font: inherit` alone was not enough to keep them
  visually identical to the old heading text — it does not carry
  `letter-spacing` or `text-transform`, so both classes declare those
  explicitly (`.page-title` sets `letter-spacing: -0.01em`; `.section-header`
  sets `text-transform: uppercase; letter-spacing: 0.5px`). Both get the
  standard `:focus-visible` ring.
- Tests: `PageTitle.test.tsx`'s `startEditing` helper now clicks the button
  rather than the heading (a click on `<h1>` no longer reaches the nested
  button); the pre-existing `sections.test.tsx` tests that use
  `getByText(/unlinked references/i)` needed no change, since that query
  resolves to the innermost element whose *direct* text children match, which
  is now the button. `styles.test.ts` adds both classes to the audited
  bare-button ring list plus a describe block asserting the inherited
  typography.
- `docs/architecture/frontend.md` § Focus and interactive affordances: added
  a fourth trap ("Two traps" → now four) documenting the heading-onClick
  pattern and its fix.

Verified: `pnpm test:unit` (115 files, 1746 tests) and `pnpm test:coverage`
(thresholds met) both pass; `pnpm typecheck` clean. No other call site in the
suite clicked the `PageTitle` heading directly, so no other test needed
migration.
