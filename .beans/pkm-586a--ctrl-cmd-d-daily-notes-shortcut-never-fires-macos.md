---
# pkm-586a
title: 'Ctrl-Cmd-D daily-notes shortcut never fires: macOS reserves it for dictionary lookup; rebind to Ctrl-Shift-D'
status: in-progress
type: bug
created_at: 2026-07-10T19:38:44Z
updated_at: 2026-07-10T19:38:44Z
---

The Ctrl+Cmd+D shortcut added in pkm-bz6n (App.tsx) works in unit tests but not with a real keyboard: macOS intercepts Ctrl+Cmd+D system-wide for 'Look Up in Dictionary' at the text-input layer, so the browser page never receives the keydown. Not disableable via System Settings/symbolic hotkeys. Arthur chose Ctrl+Shift+D as the replacement.

- [x] Update App.test.tsx: Ctrl+Shift+D navigates home; Ctrl+Cmd+D no longer bound
- [x] Rebind handler in App.tsx to ctrlKey+shiftKey+d
- [x] Run web tests + typecheck (357 passed, tsc clean)
- [ ] Merge --no-ff, push, deploy to prod
