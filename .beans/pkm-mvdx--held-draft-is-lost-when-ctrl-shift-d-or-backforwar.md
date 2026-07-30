---
# pkm-mvdx
title: Held draft is lost when Ctrl-Shift-D or back/forward unmounts the outline
status: todo
type: bug
priority: high
created_at: 2026-07-30T19:09:03Z
updated_at: 2026-07-30T19:09:03Z
---

Sibling of pkm-hhbc, found while fixing it. Same root cause, different door.

A flush-held draft (caret inside a `[[ref` / `#tag` token, pkm-xlah) has no
armed debounce timer, and React delivers no blur for a node it removes. So ANY
unmount-without-blur drops the block's text. pkm-hhbc closed the Ctrl-O /
Ctrl-Shift-O door only.

Verified directly against useOutline (throwaway test):

- held draft + unmount -> `sync.sent` is `[]`. Text lost.
- ordinary debounced draft + unmount -> flushes fine; nothing cancels the
  pending setTimeout, so it fires after the outline is gone. This is why only
  held drafts are affected.

Doors still open:

- `App.tsx` global keydown: `Ctrl-Shift-D` (daily notes) calls `navigate("/")`
  with no flush. Reproduce: type `[[Anything` (caret inside the token), press
  Ctrl-Shift-D, go back -- block is empty.
- Browser back/forward while the caret is inside a token.

Not affected: tab hide/close/reload (visibilitychange flushes), clicking a
rendered ref or a nav link (blurs first), clicking anything focusable.

## Possible fix

`App.tsx` has no access to an outline's handlers, so the per-handler approach
pkm-hhbc used does not reach it. `undoManager.ts` already has a private
`flushAll()` over the registered `flushPending` hooks (used by undo/redo) --
exporting that gives a global "commit every mounted outline's draft" call for
the App-level shortcut. A flush-on-unmount effect in `useOutline` would cover
back/forward too, but check the effect-cleanup ordering: the session effect is
defined first, so `sessionRef.current` is already null by then and `run()`
falls back to `sync.enqueue` plus a setState on an unmounted component.

## Todo

- [ ] Failing test: held draft + Ctrl-Shift-D keeps the block text
- [ ] Failing test: held draft + history back keeps the block text
- [ ] Fix, without weakening the pkm-xlah hold
- [ ] docs/architecture/frontend.md: extend the pkm-hhbc note to all navigation
