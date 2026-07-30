---
# pkm-k1ak
title: Small cleanups left over from the pkm-0wg9 control polish review
status: completed
type: task
priority: normal
created_at: 2026-07-30T07:57:51Z
updated_at: 2026-07-30T15:04:57Z
---

Four small, independent items the pkm-0wg9 whole-branch review raised as Minor. None blocks anything; grouped so they don't get lost.

**1. `top-bar-search` is a dead className.** `web/src/components/SearchBar.tsx` still puts it on the wrapper, but pkm-0wg9 moved its rule to `.search-field`, and nothing in `web/src`, `web/e2e` or the CSS references the bare class any more. (The plan justified keeping it by claiming `TopBar.test.tsx` references it — that test only queries `kbd.top-bar-search-hint`.) Either drop it or comment it as an intentional stable test hook.

**2. The sidebar "Add page…" field sits flush with its container.** The shared field fill is `--color-bg-subtle`, which is exactly `.left-nav`'s own background, so that input lost the slight lift it had from `--color-bg` and is now distinguished only by its border. Every other field in the family sits on `--color-bg-surface` and reads correctly. This is the one place the one-field-family choice costs contrast instead of gaining it.

**3. `input[type=search]` is unverified on iOS Safari.** `/files` uses `type="search"` while the top bar uses a plain text input, and the shared rule now depends on `padding-left: 30px` clearing the magnifier icon. pkm-0wg9 was verified in Chrome only. This app ships as an iPad PWA, so it needs one look on a real device — `appearance: none` on `.search-field-input` is the fix if the icon collides with the native decoration.

**4. The top-bar search's font-family shifted.** It previously set only `font-size: 14px` and so rendered in the UA control font; joining the field family gave it `font: inherit`, so it now uses the body stack. A consistency improvement, and it was live-verified as fine — recorded only because the spec listed that pill as "unchanged".

- [x] Resolve the dead `top-bar-search` className
- [x] Give the sidebar Add field a surface that lifts off `.left-nav`
- [x] Check `/files` search on iOS Safari and add `appearance: none` if needed
- [x] Confirm item 4 needs no action, or note it in the design doc

## Summary of Changes

**1. Dead className removed.** `SearchBar.tsx`'s wrapper is now `className="search-field"`. `search-field` and `top-bar-search-input` both carry live rules and stay; only the bare `top-bar-search` went. `TopBar.test.tsx` queries `kbd.top-bar-search-hint`, which is untouched.

**2. The sidebar Add field takes the surface fill at rest.** `.nav-sidebar-add input` now sets `background: var(--color-bg-surface)`, so it lifts off `.left-nav`'s `--color-bg-subtle` instead of matching it. Its `:focus` can no longer shift the fill, so focus is carried by `.input-control:focus`'s `border-color` change and the focus-visible ring — both still apply.

This is the first background override on a per-call-site field rule, so the `bespoke field rules keep layout only, not colours` styles test had to be relaxed: `border`/`border-radius` stay banned for both bespoke fields, `background` stays banned for `.assistant-input textarea`, and a new test pins the nav field's exception against `.left-nav`'s own background so the pair can't drift apart. `docs/architecture/frontend.md`'s field section records the exception and why.

**3. iOS Safari: no action.** User tested `/files` search on iOS — the native search decoration does not collide with the shared `padding-left: 30px`, so no `appearance: none` is needed.

**4. Font-family shift: no action.** Confirmed intentional and already live-verified; the field section of `docs/architecture/frontend.md` now describes the shared field look, which covers `font: inherit`. No separate note warranted.
