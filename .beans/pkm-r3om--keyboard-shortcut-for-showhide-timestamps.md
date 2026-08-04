---
# pkm-r3om
title: Keyboard shortcut for show/hide timestamps
status: in-progress
type: feature
created_at: 2026-08-04T10:13:55Z
updated_at: 2026-08-04T10:13:55Z
---

Bind Ctrl+Shift+T to the block-timestamps toggle (currently page-menu only, bean pkm-4ler).

Chord: Ctrl+Shift+T, mirroring Ctrl+Shift+D. Cmd+T is browser new-tab and never reaches the page; Shift+Cmd+T is reopen-closed-tab; plain Ctrl+T is emacs transpose. Global scope, beside Cmd+/ and Cmd+J in App.tsx's window keydown listener.

Design: docs/superpowers/specs/2026-08-04-timestamps-shortcut-design.md

- [x] Add the Ctrl+Shift+T clause to App.tsx's global keydown effect (with the !e.metaKey guard, toggleStamps in deps)
- [x] App.test.tsx: toggles on and back off; fires with a block textarea focused; Ctrl+Cmd+T does not toggle
- [x] docs/keyboard.md: add the row; strip the technical aside from the Ctrl+Shift+D row (user-facing docs only)
- [x] docs/architecture/frontend.md:158: three global keys -> four, plus prose on why Ctrl+Shift, that OS-eaten chords are untestable, and that these fire with a textarea focused (BlockInput does not stopPropagation)
- [x] cd web && pnpm verify (tsc clean, 1959 unit tests, coverage met, 51 e2e)
- [ ] Arthur confirms Ctrl+Shift+T by real keypress in the running app
