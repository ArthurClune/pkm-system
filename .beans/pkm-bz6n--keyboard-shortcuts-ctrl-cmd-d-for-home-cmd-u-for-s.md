---
# pkm-bz6n
title: 'Keyboard shortcuts: Ctrl-Cmd-D for home, Cmd-U for search'
status: completed
type: feature
priority: normal
created_at: 2026-07-09T18:54:26Z
updated_at: 2026-07-09T21:23:21Z
---

Two shortcut changes:

- [x] Ctrl-Cmd-D should navigate to the home page
- [x] Search should be bound to Cmd-U instead of Cmd-K

## Summary of Changes

Both bindings live in the single `window` keydown effect in `web/src/App.tsx`:

- Search now opens on `metaKey/ctrlKey + "u"` (was `"k"`); the Cmd-K binding
  is gone entirely. `preventDefault()` is still called so no browser default
  fires.
- `ctrlKey && metaKey && key === "d"` now calls `navigate("/")` via
  `react-router-dom`'s `useNavigate`. `App` already renders inside
  `BrowserRouter` (see `web/src/main.tsx`), so the hook is used directly in
  `App()` — no extra wrapper component was needed.
- No input/textarea focus guard was added: the prior Cmd-K handler had none,
  so the new bindings match that (unguarded) behaviour rather than inventing
  new behaviour.
- Tests in `web/src/App.test.tsx` updated: cmd-u and ctrl-u open search,
  cmd-k no longer does, and ctrl-cmd-d navigates from a page route back to
  the journal (asserted via the page's `<h1>` disappearing).
- Full suite: 161/161 tests pass (`pnpm vitest run`); `pnpm typecheck` clean.
