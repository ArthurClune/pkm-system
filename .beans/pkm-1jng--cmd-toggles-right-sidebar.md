---
# pkm-1jng
title: Cmd-/ toggles right sidebar
status: completed
type: feature
priority: normal
created_at: 2026-07-10T19:31:29Z
updated_at: 2026-07-10T19:33:48Z
---

Cmd-/ (or Ctrl-/) toggles visibility of the right sidebar (the stacked panels opened via shift-click / page menu), matching Roam's shortcut.

Design decisions:
- Handled in App.tsx's existing window keydown effect, same (metaKey || ctrlKey) pattern as Cmd-U.
- Visibility is session-local state, not persisted: the panel stack itself is session-only, so a persisted hidden flag would only ever apply to an empty stack.
- openInSidebar un-hides the sidebar so opening a panel while hidden is not a silent no-op.
- With an empty stack the toggle is a harmless no-op (the aside only renders when panels exist).

## Tasks

- [x] Tests in App.test.tsx (toggle hides/shows, ctrl variant, openInSidebar un-hides)
- [x] Implement in App.tsx
- [x] pnpm test + typecheck
- [ ] Merge --no-ff and push

## Summary of Changes

Cmd-/ (or Ctrl-/) now toggles the right sidebar's visibility. Implemented in App.tsx's existing window keydown handler; session-only hidden flag gates rendering of the aside.sidebar; openInSidebar clears the flag. Four new tests in App.test.tsx; full web suite (356 tests) and typecheck pass.
