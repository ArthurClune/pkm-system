---
# pkm-r3om
title: Keyboard shortcut for show/hide timestamps
status: completed
type: feature
priority: normal
created_at: 2026-08-04T10:13:55Z
updated_at: 2026-08-04T10:22:36Z
---

Bind Ctrl+Shift+T to the block-timestamps toggle (currently page-menu only, bean pkm-4ler).

Chord: Ctrl+Shift+T, mirroring Ctrl+Shift+D. Cmd+T is browser new-tab and never reaches the page; Shift+Cmd+T is reopen-closed-tab; plain Ctrl+T is emacs transpose. Global scope, beside Cmd+/ and Cmd+J in App.tsx's window keydown listener.

Design: docs/superpowers/specs/2026-08-04-timestamps-shortcut-design.md

- [x] Add the Ctrl+Shift+T clause to App.tsx's global keydown effect (with the !e.metaKey guard, toggleStamps in deps)
- [x] App.test.tsx: toggles on and back off; fires with a block textarea focused; Ctrl+Cmd+T does not toggle
- [x] docs/keyboard.md: add the row; strip the technical aside from the Ctrl+Shift+D row (user-facing docs only)
- [x] docs/architecture/frontend.md:158: three global keys -> four, plus prose on why Ctrl+Shift, that OS-eaten chords are untestable, and that these fire with a textarea focused (BlockInput does not stopPropagation)
- [x] cd web && pnpm verify (tsc clean, 1959 unit tests, coverage met, 51 e2e)
- [x] Arthur confirms Ctrl+Shift+T by real keypress in the running app (confirmed working in prod, 2026-08-04)

## Summary of Changes

Ctrl+Shift+T toggles the block-timestamp column from anywhere in the app.

- `web/src/App.tsx` — a fourth clause in the existing global window keydown
  effect, `!e.metaKey` guarded so Ctrl+Cmd+T stays unbound. `toggleStamps` was
  already in scope and is a stable `useCallback`, so adding it to the effect's
  deps does not re-subscribe the listener.
- `web/src/App.test.tsx` — toggles on and back off; fires with a block textarea
  focused (dispatched *on the textarea*, so it exercises the propagation path
  rather than assuming it); Ctrl+Cmd+T does not toggle.
- `docs/keyboard.md` — one user-facing row, no rationale. The Ctrl+Shift+D row
  also lost its dictionary-lookup aside: this page is user-facing only.
- `docs/architecture/frontend.md` — why the Ctrl+Shift family exists (Cmd+T is
  browser new-tab, Ctrl+Cmd+D is macOS dictionary lookup, neither reaches the
  page), that no automated test can detect a swallowed chord, and that these
  chords depend on `BlockInput` not calling `stopPropagation`. The stale "Three
  global keys" count became four.

Verified: `pnpm verify` green (tsc, 1959 unit tests, coverage thresholds, 51
E2E). Deployed at 6d309e7 and confirmed in the served bundle. Arthur confirmed
the chord by real keypress in prod — the one check automation cannot make.

Design: `docs/superpowers/specs/2026-08-04-timestamps-shortcut-design.md`
