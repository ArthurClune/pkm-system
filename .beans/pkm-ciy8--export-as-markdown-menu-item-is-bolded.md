---
# pkm-ciy8
title: Export as Markdown menu item is bolded
status: completed
type: bug
created_at: 2026-07-25T12:02:10Z
updated_at: 2026-07-25T13:16:00Z
---

The 'Export as Markdown' item in the TopBar page menu renders bold while sibling menu items are regular weight. It's an <a role=menuitem> among <button>s — normalize styling.

## Root Cause

`web/src/styles.css` has a global `a { color: var(--color-link-ext);
font-weight: 600; text-decoration: none; }` rule (pkm-1eaj). The menu's own
rule, `.top-bar-menu button, .top-bar-menu a { ... }`, is more specific
(0,1,1 vs 0,0,1) and does override `color`/`text-decoration`, but it never
set `font-weight` at all — so that one property fell through the cascade
to the global `a` rule's `font-weight: 600`, while sibling `<button>`
elements picked up plain `font: inherit` (normal weight) from the separate
`button { font: inherit; }` reset. The anchor and buttons were never
actually targeted by a shared font-weight rule; the anchor was just
inheriting bold from an unrelated selector.

## Summary of Changes

- `web/src/styles.css`: added `font-weight: normal;` to the `.top-bar-menu
  button, .top-bar-menu a` rule, plus a comment explaining why the anchor
  picked up bold from the global `a` rule. No other menu/link styling
  touched.
- `web/src/styles.test.ts`: added a `describe("top bar page menu
  (pkm-ciy8)")` assertion pinning `font-weight: normal;` (alongside the
  existing `text-decoration`/`color` values) on that selector, following
  the file's `ruleFor()` pattern used for the other pkm-1eaj/pkm-absu link
  cases.
- Did not touch `web/src/components/TopBar.test.tsx`: the styles.test.ts
  pattern already covers CSS-level cascade assertions for this file, and a
  jsdom component test can't observe the real stylesheet's computed
  font-weight.

## Verification

`cd web && E2E_PORT=8976 pnpm verify` — clean pass (see pkm-5nif for the
full run detail; same session, same verification run covered both beans):
`tsc`, `eslint`, `check:fcis`, 1445/1445 unit tests (incl. new
styles.test.ts case, all 20 existing TopBar.test.tsx cases still green),
`vite build`, 34/34 Playwright e2e. Not merged to main; not deployed.
