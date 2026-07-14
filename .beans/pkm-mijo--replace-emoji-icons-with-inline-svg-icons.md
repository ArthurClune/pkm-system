---
# pkm-mijo
title: Replace emoji icons with inline SVG icons
status: completed
type: feature
priority: high
created_at: 2026-07-14T20:06:09Z
updated_at: 2026-07-14T20:17:37Z
parent: pkm-heod
---

The 🌓/☀️/🌙 theme toggle emoji and the bare "‹" / "..." bordered boxes in the top bar are the main things making the chrome feel unfinished.

- [x] Small inline-SVG icon set (no icon-font/dep): sun, moon, half-moon (system), sidebar-toggle, kebab menu, search
- [x] Theme toggle uses SVG icon + label
- [x] Sidebar toggle + page "..." menu buttons use icons with consistent ghost styling (no border until hover)
- [x] Search input gets a leading search icon
- [x] Icons use currentColor so both themes work for free

## Summary of Changes

- New `web/src/components/icons.tsx`: 16px stroke-based inline SVGs (sun, moon, auto half-circle, panel-left, more-horizontal, search, menu), all currentColor and aria-hidden.
- ThemeToggle, TopBar sidebar toggle, page kebab menu, SearchBar, and the mobile hamburger now use them (no emoji left in the chrome).
- Toggle + kebab restyled as ghost buttons: transparent border, bg-subtle on hover; search input gained a leading icon (30px left padding).
