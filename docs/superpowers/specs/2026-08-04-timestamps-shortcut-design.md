# Keyboard shortcut for show/hide timestamps

**Date:** 2026-08-04

## Goal

Give the block-timestamps toggle (bean pkm-4ler, currently reachable only
through the page menu) a keyboard shortcut, and record why the app's global
chords avoid the obvious Cmd-letter forms.

## The chord: Ctrl+Shift+T

`Cmd+T` is unusable — Chrome and Safari both claim it for "new tab" and never
deliver the keydown to the page. `Shift+Cmd+T` is likewise taken (reopen
closed tab; Safari's tab bar). Plain `Ctrl+T` is the emacs transpose-chars
binding that `docs/keyboard.md` explicitly leaves to the browser.

`Ctrl+Shift+T` is free in Chrome, Safari, Firefox and macOS, and Shift takes
it clear of emacs `Ctrl+T`. It also mirrors the existing `Ctrl+Shift+D` (go to
daily notes), which exists for exactly this reason — `Ctrl+Cmd+D` is reserved
by macOS for dictionary lookup.

`Cmd+Alt+T` was considered, since `Cmd+Alt` is already app vocabulary
(`Cmd+Alt+0/1/2/3` for headings). Rejected: `Cmd+Alt+letter` is devtools
territory in Chrome (I, J, C, U all taken), so T is one browser release from
being claimed.

## Scope: global

The chord lives beside `Cmd+/` and `Cmd+J` in `App.tsx`'s window keydown
listener and fires anywhere in the app, not just on a page view. The
preference is already global (`blockStampsPref.ts` — one setting, not
per-page), so pressing it on `/files` or a search view simply takes effect on
the next page opened. Gating it on `title !== null` to match the menu item's
render condition would cost a route check the other global chords don't have
and would make the key silently dead where the setting is still meaningful.

## Implementation

### 1. The binding — `web/src/App.tsx`

A third clause in the existing window keydown effect (currently lines
116–135):

```ts
if (e.ctrlKey && e.shiftKey && !e.metaKey && e.key.toLowerCase() === "t") {
  e.preventDefault();
  toggleStamps();
}
```

`toggleStamps` is already in scope at line 50 (`useBlockStampsPref()`), and is
a `useCallback` with empty deps (`useBlockStampsPref.ts:39`), so adding it to
the effect's dependency array does not re-subscribe the listener on each
render.

The `!e.metaKey` guard copies the `Ctrl+Shift+D` clause directly above, so
`Ctrl+Shift+Cmd+T` does not fire the toggle. (The `Cmd+/` and `Cmd+J` clauses
have no such guard, but the Ctrl+Shift family does, and this chord belongs to
that family.)

### 2. Firing while a block is being edited

No code needed: `BlockInput` does not `stopPropagation` on keydown, so the
window listener sees the chord with a textarea focused — the same reason
`Cmd+/` and `Cmd+J` work while editing. This is covered by a test, because it
would regress silently if propagation guards were ever added to the editor.

### 3. No change to `TopBar`

The menu item stays "Show timestamps" / "Hide timestamps" with no shortcut
hint. None of the four items in that menu carries one, and annotating only
this one would look arbitrary.

## Documentation

`docs/keyboard.md` is user-facing only — no design or technical rationale
there. It is imported raw by `web/src/views/Help.tsx`, so the edit also
updates the in-app help page.

- Add to the "Anywhere in the app" table:
  `| Ctrl+Shift+T | Show / hide block timestamps |`
- Strip the existing technical aside from the `Ctrl+Shift+D` row, so it reads
  just `Go to Daily Notes`. Its reason moves to the architecture doc below,
  next to the `Cmd+T` reason.

`docs/architecture/frontend.md`, at the "Three global keys" sentence (line
158):

- The count becomes four, and the sentence gains `Ctrl+Shift+T`. (A count in
  prose that goes stale silently — the exact trigger CLAUDE.md flags.)
- A short prose note carrying what was removed from the user-facing page plus
  the two mechanisms behind it:
  - Why global chords use the Ctrl+Shift family: `Cmd+T` (new tab) and
    `Ctrl+Cmd+D` (macOS dictionary lookup) never reach the page, so the
    Cmd forms are not available to claim.
  - **No automated test can detect an OS- or browser-eaten chord** — jsdom
    and Playwright both deliver a synthetic keydown the real OS would have
    swallowed. A new global chord must be confirmed by a real keypress in the
    running app before merge.
  - These chords fire with a block textarea focused because `BlockInput` does
    not `stopPropagation` on keydown.

## Testing

In `web/src/App.test.tsx`, mirroring the `Ctrl+Shift+D` tests at lines
268–288 (`fireEvent.keyDown(window, …)`):

1. `Ctrl+Shift+T` shows the block-stamp column, and a second press hides it.
2. The chord fires while a block textarea holds focus.
3. `Ctrl+Cmd+T` does **not** toggle (the `!e.metaKey` guard).

Then the standard gates: `cd web && pnpm verify` (typecheck, enforced unit
coverage, Playwright E2E).

Finally, a manual keypress check in the running app — the one thing the suite
above cannot establish.

## Out of scope

- Shortcut hints inside the page menu.
- A per-page timestamps setting.
- Any change to `keyboardPolicy.ts`: this is an app-level global chord, not an
  editor key decision.
