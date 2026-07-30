---
# pkm-mvdx
title: Held draft is lost when Ctrl-Shift-D or back/forward unmounts the outline
status: completed
type: bug
priority: high
created_at: 2026-07-30T19:09:03Z
updated_at: 2026-07-30T19:26:55Z
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

- [x] Failing test: held draft + Ctrl-Shift-D keeps the block text
- [x] Failing test: held draft + history back keeps the block text
- [x] Fix, without weakening the pkm-xlah hold
- [x] docs/architecture/frontend.md: extend the pkm-hhbc note to all navigation

## Summary of Changes

Fixed in the pkm-hhbc branch, at the user's request.

One mechanism covers every door: `useOutline` now flushes on unmount. Both
Ctrl-Shift-D and back/forward work by unmounting the outline, so neither needs
its own hook, and `App.tsx` is untouched (`undoManager.flushAll` stayed
private). The hold itself is unchanged.

- Unmount-only by construction: the callback is read from a ref, with an
  empty dep array, so a changing `flushNow` identity can never turn this into
  a mid-edit flush.
- Placed after the session effect, so by the time it runs the session handle
  is released and `run()` takes its existing no-session branch: the ops still
  reach the durable queue, and there is nothing left to render into.

Tests (failing first):

- `useOutline.draftHold.test.tsx` -- unmount with a held draft sends the
  `update_text` batch; unmount of an untouched outline sends nothing.
- `EditablePage.test.tsx` -- a real router transition away from the page, via
  a click that moves no focus in jsdom (exactly the no-blur condition these
  navigations create), flushes the held draft.

### Why no App-level Ctrl-Shift-D test

Probed it: rendering `<App/>` and firing the chord does navigate (the journal
fetch fires), but the op queue posts no `/api/ops` in jsdom, so there is
nothing to assert on. The chord's only new dependency is the unmount flush,
which is covered directly above.

Verified: `pnpm verify` green (typecheck, lint, fcis, 1703 unit tests,
coverage 97.38%, bundle budgets, 46 E2E).
