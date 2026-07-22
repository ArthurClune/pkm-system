---
# pkm-9jwr
title: 'In-app help page: render docs/keyboard.md at a /help route'
status: in-progress
type: feature
priority: normal
created_at: 2026-07-22T18:49:57Z
updated_at: 2026-07-22T18:55:27Z
---

Surface the keyboard shortcut reference (docs/keyboard.md, added 2026-07-23) as a help page in the app. Needs: a route (e.g. /help or /help/keyboard) rendering the markdown through the app's existing render pipeline, the doc bundled or served so the SPA can load it, and an entry point in the UI (top-bar menu item and/or a shortcut). Keep docs/keyboard.md the single source of truth — the page should render that file, not a copy.

## Plan

- [ ] TDD: functional-core markdown-subset parser (h1-h3, paragraphs, tables, backtick code spans) with tests
- [ ] Help view rendering docs/keyboard.md via ?raw build-time import
- [ ] /help route in App.tsx
- [ ] TopBar help entry point
- [ ] E2E: /help renders shortcut tables; entry point navigates
- [ ] pnpm verify green
