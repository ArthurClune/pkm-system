---
# pkm-kk0t
title: Extract shared stored-preference stale-response and flash-target hooks
status: completed
type: task
priority: low
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:24Z
updated_at: 2026-08-18T20:00:09Z
parent: pkm-wvvu
---

## Review findings

Frontend A6 systematic React-idiom duplication.

## Acceptance criteria

- [x] Add a typed `useStoredPref(key, guard, fallback)` and migrate theme, sidebar-collapse, and block-stamp preferences
- [x] Add a stale-response token helper whose cancellation/bump semantics are explicit, then migrate consumers where the lifecycle truly matches
- [x] Add a shared scroll-and-flash target hook for main-page and sidebar roots
- [x] Preserve storage failure fallbacks, StrictMode behavior, response supersession, scoped selectors, cleanup timers, and hash navigation
- [x] Avoid forcing Files generation/query-key behavior through the hook if its contract is materially different
- [x] Add focused hook and migrated-consumer tests

## Summary of Changes

Three shared hooks, each with a contract stated in its own header comment.

**`web/src/useStoredPref.ts`** — `useStoredPref(key, guard, fallback)` returns
a `[value, setValue]` pair with `useState`'s setter, updater form included.
Reads once through the guard on mount and writes back on every change; a read
that throws yields the fallback and a write that throws is dropped, so the
value keeps working in memory. Migrated: `useTheme`, `useSidebarCollapsed`,
`useBlockStampsPref` — each now holds only its own concern (the `matchMedia`
listener and `data-theme` stamping for theme, the derived boolean and toggle
for the other two).

**`web/src/useStaleGuard.ts`** — `begin()` / `cancel()` / `isStale(token)` for
a surface holding at most ONE live request. `cancel()` is separate from
`begin()` on purpose: a cleared query needs the in-flight answer invalidated
without a new request being started. Migrated: `useTitleOptions`
(AutocompletePopup), `SearchBar`, `QueryBlock`.

**Not migrated: `Files.tsx`.** Its generation is a query key for the current
filter set, and `loadMore`/`selectAll` join the generation `reload` started
rather than beginning their own — several requests are legitimately valid at
once, which `begin()`-per-request would break. Its local helpers stay, with a
comment saying why.

**`web/src/useScrollFlashTarget.ts`** — `useScrollFlashTarget(uid, ready, root?)`
scrolls a `[data-uid]` block into view and flashes it for `FLASH_MS` (1600ms,
matching the `.flash-target` animation), clearing the timer on cleanup.
`ready` is the caller's payload, not a boolean derived from it, so a resync
that replaces the payload re-runs the scroll as the main pane always has.
`root`, when given, scopes the lookup and never falls back to the document —
the same page can be open in the main pane and a sidebar panel at once.
Migrated: `PageView` (hash target, document-wide) and `EditableSidebarPanel`
(uid prop, scoped to its container).

`SearchBar.cancel` became a `useCallback`: the guard is a hook value rather
than a ref, so the Cmd/Ctrl-U effect now lists it as a dependency. The guard's
identity is stable, so the listener still binds once at mount.

### Tests

New: `useStoredPref.test.ts` (8), `useStaleGuard.test.ts` (5),
`useScrollFlashTarget.test.ts` (9), `useBlockStampsPref.test.ts` (5) — the
block-stamps persistence path had no test before. Added two `useTitleOptions`
cases to `AutocompletePopup.test.tsx` pinning both halves of the guard
contract. Storage read/write failure, StrictMode double mount, supersession,
root scoping, unmounted-root no-op, `CSS.escape`, and timer cleanup are each
pinned directly.

`cd web && CI=true E2E_PORT=8993 pnpm verify` passes: 2274 unit tests across
142 files, coverage 98.17% statements / 94.13% branches (thresholds 95/91),
54 Playwright e2e.

`docs/architecture/frontend.md` module map gained the three hooks.
