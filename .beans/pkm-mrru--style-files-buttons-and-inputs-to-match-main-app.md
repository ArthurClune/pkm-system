---
# pkm-mrru
title: Style /files buttons and inputs to match main app
status: completed
type: feature
priority: normal
created_at: 2026-07-29T16:13:01Z
updated_at: 2026-07-29T18:27:22Z
---

The file explorer (/files, web/src/views/Files.tsx) uses mostly unstyled native buttons and input boxes. Give them basic CSS so they match the overall look of the main app.

- [x] Buttons (e.g. 'Scan for undescribed files', delete/export actions) should use the app's existing button styling — reuse the design tokens from the design-polish epic (--radius-*, .btn-secondary) rather than inventing new styles
- [x] Search/filter input boxes need matching treatment
- [x] Keep it consistent in light and dark themes

## Root cause

Not a missing import — styles.css is one global sheet (main.tsx) and the
`.files-*` rules were applying. Two structural gaps:

1. `.btn-secondary` (pkm-9kye) carried colour/border/radius but no padding —
   "owning classes keep only their layout". Every other consumer supplied its
   own geometry (`.show-more`, `.reference-link-button`, `.composer-send`,
   `.confirm-dialog-actions button`, ...). Files.tsx used the class bare, so
   its buttons fell back to the UA's cramped metrics. Any new bare call site
   would have been wrong the same way.
2. There was no base or shared style for form controls at all — only
   `button { font: inherit }`, no `input`/`select` rule. Every input in the app
   was styled by a bespoke context class, so Files' unclassed filter widgets
   rendered as raw native controls.

A third gap surfaced during visual verification: the app never declared
`color-scheme`, so Chrome painted `<select>`/`<input type=date>` (and their
popups, and scrollbars) in light mode even in dark theme, ignoring the author
background-color.

## Summary of Changes

- `.btn-secondary` / `.btn-danger` now own a default `padding: 4px 12px`, so a
  bare call site is correct by default. Verified every existing override still
  wins (later source order or higher specificity); `.show-more` dropped its
  now-redundant duplicate.
- New `.input-control` token (font/padding/border/radius/bg/colour, placeholder
  colour, focus ring) — the input counterpart of `.btn-secondary`. Opt-in by
  class rather than a base `input`/`select` rule, which would have hit
  checkboxes and the outline's own editors.
- `color-scheme: light` / `dark` declared in all three theme rules, so native
  widgets, their popups and scrollbars follow the theme. Also fixes the
  assistant panel's model `<select>`, which was a white widget in dark mode.
- Files.tsx: the five filter widgets take `.input-control`; `.files-search`
  flexes to fill; `.files-filters label` uses inline-flex + gap; `.file-copy`
  stays compact inside the 160px card.
- Tests: 5 new drift-guard assertions in styles.test.ts, 1 in Files.test.tsx.
  Verified visually in light and dark against a scratch server with 9 uploaded
  assets (buttons, filter row, selection toolbar, confirm dialog, assistant
  panel).
