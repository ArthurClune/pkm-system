---
# pkm-10ah
title: Shift-click on a left-nav page link opens a new window instead of the sidebar
status: completed
type: bug
priority: normal
created_at: 2026-08-04T09:38:23Z
updated_at: 2026-08-04T09:52:27Z
---

Shift-clicking a pinned page in the left nav (and the TODO link) falls through to the browser's native shift-click, opening a second app window. Two copies of the app then warn about the same page being open twice. Everywhere else in the app -- PageLink, BlockRef, AssetLink, SearchBar, the TopBar page menu -- shift-click means 'open in the right-hand sidebar'; the left nav's NavLinks never opted in.

## Root cause

web/src/components/SidebarNav.tsx renders each pinned entry as a bare <NavLink to={pagePath(title)}> with no shiftKey branch, as does App.tsx's TODO link. PageLink.tsx does e.preventDefault() + openInSidebar(title) on e.shiftKey; the nav links have no such handler, so the default action (open in new window) runs.

## Fix

- [x] Failing tests: shift-click a pinned nav entry -> openInSidebar, no navigation; shift-click TODO -> sidebar panel opens
- [x] Share the shift-click contract in one place rather than duplicating it per call site
- [x] SidebarNav pinned entries honour shift-click
- [x] App.tsx TODO link honours shift-click
- [x] Non-page destinations (Daily Notes, Current Work, Files, Settings) trap shift-click as an outright no-op (Arthur's follow-up): swallow the click, no window, no navigation, drawer left open
- [x] docs/architecture/frontend.md: the 'shift-clicking any page link' note should say that nav links opt in explicitly
- [x] pnpm verify

## Summary of Changes

New `web/src/components/NavPageLink.tsx` holds the left nav<->sidebar contract in one place: a NavLink to `pagePath(title)` that, on a shift-click, preventDefaults and calls `openInSidebar(title)`. `SidebarNav`s pinned entries and App.tsxs TODO link both render it; `pagePath`/`NavLink` imports dropped from each where they became unused. `onNavigate` still fires on a shift-click so the phone drawer cant cover the panel it just opened.

The underlying reason the bug existed at all: react-routers `shouldProcessLinkClick` bails on any modified click, so a NavLink with no shiftKey branch hands shift-clicks to the browser, which opens the app in a second window -- two live copies of one page, hence the sync warning.

Deliberately unchanged: Daily Notes, Current Work, Files, Settings keep native shift-click. A SidebarPanel renders a page *by title* and no page sits behind those routes. An App test pins that decision.

Tests: SidebarNav unit test (openInSidebar called, default prevented, onNavigate still fires), two App tests (TODO opens a panel; /files untouched), and `e2e/nav-shift-click.spec.ts` -- the only test that can prove the second window is gone, verified red before the fix (no `.sidebar-panel-title`) and green after, with `context.on("page")` catching zero popups. Full `pnpm verify` green: 50 e2e, coverage, typecheck, lint, FCIS.

Note for future e2e/unit work: asserting a click is *not* prevented leaves jsdom asynchronously attempting a real navigation, which logs "Not implemented: navigation" against whatever test happens to be running then. The /files test reads `defaultPrevented` from a document-level listener (it runs after Reacts container handler) and prevents the default itself.

## Follow-up: non-page destinations trap shift-click too

The first pass left Daily Notes / Current Work / Files / Settings on native shift-click, on the grounds that a panel has no page to show there. Arthur asked for them to be trapped and mapped to a no-op instead -- the second window is the problem, and "nothing happens" beats "a whole second copy of the app".

New `NavRouteLink` is the counterpart to `NavPageLink`: it preventDefaults a shift-click and returns, deliberately without firing `onNavigate`, so a phone drawer stays open rather than closing onto nothing. All four nav route links use it; App.tsx no longer imports NavLink at all, and the pkm-rwwp focus comment that said "every NavLink calls setNavOpen(false) unconditionally" was corrected, since a swallowed click now doesn't.

Tests: the App test that used to pin native behaviour now demands the no-op across all four links (event prevented, top-bar label unchanged, no sidebar panel), plus one asserting the drawer stays open. In e2e, a second spec shift-clicks Daily Notes/Files/Settings and asserts zero popups -- red before the fix with 2 real popup windows caught by context.on("page"), green after. Full `pnpm verify`: 1956 unit tests, 97.68% lines, 51 e2e.

Not changed: Cmd-click still opens a real tab everywhere (standard gesture, and the sync warning it can cause is a separate question). The Assistant nav item is a button, so it has no native modified-click behaviour to trap.
