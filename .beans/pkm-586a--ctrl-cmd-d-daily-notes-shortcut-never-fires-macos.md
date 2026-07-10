---
# pkm-586a
title: 'Ctrl-Cmd-D daily-notes shortcut never fires: macOS reserves it for dictionary lookup; rebind to Ctrl-Shift-D'
status: completed
type: bug
priority: normal
created_at: 2026-07-10T19:38:44Z
updated_at: 2026-07-10T19:41:34Z
---

The Ctrl+Cmd+D shortcut added in pkm-bz6n (App.tsx) works in unit tests but not with a real keyboard: macOS intercepts Ctrl+Cmd+D system-wide for 'Look Up in Dictionary' at the text-input layer, so the browser page never receives the keydown. Not disableable via System Settings/symbolic hotkeys. Arthur chose Ctrl+Shift+D as the replacement.

- [x] Update App.test.tsx: Ctrl+Shift+D navigates home; Ctrl+Cmd+D no longer bound
- [x] Rebind handler in App.tsx to ctrlKey+shiftKey+d
- [x] Run web tests + typecheck (357 passed, tsc clean)
- [x] Merge --no-ff, push, deploy to prod (c8329ff, verified new binding in served bundle)

## Summary of Changes

Root cause: macOS reserves Ctrl+Cmd+D system-wide for "Look Up in Dictionary" at the text-input layer, so the browser page never receives the keydown. The pkm-bz6n binding only ever worked in unit tests, where synthetic events bypass the OS. Not disableable via System Settings (not a symbolic hotkey).

Fix: rebound to Ctrl+Shift+D (Arthur's choice) in `web/src/App.tsx`, requiring `!metaKey` so the combo is unambiguous. Replaced the old test with two: Ctrl+Shift+D navigates home, and Ctrl+Cmd+D is no longer bound. 357 web tests + typecheck pass. Merged --no-ff as c8329ff, deployed to prod, and verified the new handler is present in the served bundle.
