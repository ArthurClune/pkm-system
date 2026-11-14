---
# pkm-06os
title: Find in page (Cmd-F / Cmd-G) in the installed app
status: completed
type: feature
priority: normal
created_at: 2026-11-14T14:50:01Z
updated_at: 2026-11-14T15:46:02Z
---

In the installed PWA (display-mode: standalone) Cmd-F and Cmd-G do nothing, since there is no browser chrome to provide find. Add an in-app find bar that only takes the keys in standalone mode.


Spec: docs/superpowers/specs/2026-11-14-pwa-find-in-page-design.md
Plan: docs/superpowers/plans/2026-11-14-pwa-find-in-page.md

- [x] Pure matcher (findMatches.ts)
- [x] Page text shell (pageText.ts)
- [x] FindBar, App wiring, styles, docs
- [x] E2E spec and pnpm verify


## Summary of Changes

In the installed app only (`display-mode: standalone`), Cmd+F opens an in-app find bar over the main pane and right sidebar; Cmd+G / Shift+Cmd+G and Enter / Shift+Enter step through matches, Escape closes it and returns to the block you were in. Matches paint with the CSS Custom Highlight API (no DOM changes); the bar stands down while a full-screen modal is open. Shortcuts are in docs/keyboard.md § Anywhere in the app and § Find on page; the mechanism is in frontend.md's standalone-quirks table.

Verified: full `pnpm verify`, perf frontend unchanged, WebKit in the iPad simulator (synthetic keydowns). Not verifiable by automation: whether a Safari Dock app and the iPad home-screen app deliver Cmd+F/Cmd+G keydowns to the page from a real keyboard.
