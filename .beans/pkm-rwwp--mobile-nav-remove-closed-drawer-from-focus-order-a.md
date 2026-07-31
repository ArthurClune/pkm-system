---
# pkm-rwwp
title: 'Mobile nav: remove closed drawer from focus order, add ARIA state'
status: completed
type: bug
priority: high
created_at: 2026-07-31T16:05:42Z
updated_at: 2026-07-31T19:32:34Z
parent: pkm-6phf
---

Finding 4 of epic pkm-6phf (web review).

**References:** web/src/styles.css:698-706; web/src/App.tsx:128-173

The closed phone navigation is hidden only with transform: translateX(-100%); descendants remain tabbable off-screen. The hamburger also lacks aria-expanded and aria-controls.

**Direction:** Apply inert or visibility:hidden while closed, restore visibility for .open, add expanded/control semantics, and manage focus restoration.

- [x] Add mobile keyboard-order and focus-restoration coverage
- [x] Make closed navigation inert and expose correct ARIA state

## Summary of Changes

- `web/src/styles.css` (`@media (max-width: 600px)`): the closed `.left-nav`
  now sets `visibility: hidden` in addition to the existing
  `transform: translateX(-100%)`, taking the whole subtree out of the tab
  order; `.left-nav.open` restores `visibility: visible`. `visibility` is
  transitioned alongside `transform` (`0.15s` each) so the slide animation is
  still seen — a `visibility` transition holds `visible` for the duration
  when moving to `hidden`, and applies immediately when moving to `visible`.
  `inert` was not used: React 18.3 (`web/package.json:24`) has no `inert`
  prop, so CSS is the only mechanism available. Both declarations are scoped
  to the phone media query on purpose — at every wider breakpoint the nav is
  permanent and `navOpen` is meaningless, and applying `visibility: hidden`
  unscoped would hide the desktop nav.
- `web/src/App.tsx`: the hamburger button now carries `aria-expanded={navOpen}`
  and `aria-controls="left-nav"`, and the `<nav>` gets `id="left-nav"` to
  match. A new ref (`hamburgerRef`) and effect return focus to the hamburger
  when `navOpen` transitions from `true` to `false` (tracked via
  `navWasOpenRef`), so a keyboard user closing the drawer — whether via the
  hamburger itself or by picking a destination `NavLink` — never has focus
  stranded on a `visibility: hidden` link. The guard on the *previous* state
  is required because every `NavLink`'s `onClick` calls `setNavOpen(false)`
  unconditionally: on desktop `navOpen` is already `false`, the effect does
  not fire (no state change), but without the guard a mount-time run or a
  no-op call could otherwise pull focus onto a `display: none` hamburger.
- Tests: `web/src/styles.test.ts` gained a `describe` block asserting the
  closed/open `visibility`/`transition` declarations via `mediaRulesFor`.
  `web/src/App.test.tsx` gained three tests: ARIA state toggling on click,
  focus restoration to the hamburger (both self-close and destination-click
  paths), and a regression guard that a never-opened drawer does not steal
  focus on mount or on an ordinary desktop navigation.
- Docs: `docs/architecture/frontend.md` § *Focus and interactive
  affordances* — added a third bullet to the trap list (renamed "Two traps"
  to "Three traps") describing the off-screen-drawer trap and the fix.
