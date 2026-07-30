---
# pkm-k1ak
title: Small cleanups left over from the pkm-0wg9 control polish review
status: todo
type: task
created_at: 2026-07-30T07:57:51Z
updated_at: 2026-07-30T07:57:51Z
---

Four small, independent items the pkm-0wg9 whole-branch review raised as Minor. None blocks anything; grouped so they don't get lost.

**1. `top-bar-search` is a dead className.** `web/src/components/SearchBar.tsx` still puts it on the wrapper, but pkm-0wg9 moved its rule to `.search-field`, and nothing in `web/src`, `web/e2e` or the CSS references the bare class any more. (The plan justified keeping it by claiming `TopBar.test.tsx` references it — that test only queries `kbd.top-bar-search-hint`.) Either drop it or comment it as an intentional stable test hook.

**2. The sidebar "Add page…" field sits flush with its container.** The shared field fill is `--color-bg-subtle`, which is exactly `.left-nav`'s own background, so that input lost the slight lift it had from `--color-bg` and is now distinguished only by its border. Every other field in the family sits on `--color-bg-surface` and reads correctly. This is the one place the one-field-family choice costs contrast instead of gaining it.

**3. `input[type=search]` is unverified on iOS Safari.** `/files` uses `type="search"` while the top bar uses a plain text input, and the shared rule now depends on `padding-left: 30px` clearing the magnifier icon. pkm-0wg9 was verified in Chrome only. This app ships as an iPad PWA, so it needs one look on a real device — `appearance: none` on `.search-field-input` is the fix if the icon collides with the native decoration.

**4. The top-bar search's font-family shifted.** It previously set only `font-size: 14px` and so rendered in the UA control font; joining the field family gave it `font: inherit`, so it now uses the body stack. A consistency improvement, and it was live-verified as fine — recorded only because the spec listed that pill as "unchanged".

- [ ] Resolve the dead `top-bar-search` className
- [ ] Give the sidebar Add field a surface that lifts off `.left-nav`
- [ ] Check `/files` search on iOS Safari and add `appearance: none` if needed
- [ ] Confirm item 4 needs no action, or note it in the design doc
