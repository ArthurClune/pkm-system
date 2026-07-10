---
# pkm-fatg
title: Search should be a search bar that focuses on click/keyboard, not a button
status: completed
type: bug
priority: normal
created_at: 2026-07-10T18:55:31Z
updated_at: 2026-07-10T19:19:54Z
---

The search control at the top is currently a button. It should be a search bar (input) that receives focus when clicked or when triggered via keyboard shortcut.

## Summary of Changes

Replaced the top-bar 'Search' button + SearchModal overlay with an inline SearchBar (web/src/components/SearchBar.tsx): a real input in the top bar with a results dropdown anchored beneath it. Clicking the bar focuses it directly; Cmd/Ctrl-U focuses it from anywhere (pressing again cancels). All modal search logic (debounce, stale-response guard, create-page row, keyboard navigation) carried over unchanged. TopBar lost its onSearchClick prop; App no longer owns search state. Styles: .top-bar-search-input (widens on focus) and dropdown .search-results; modal styles removed. Verified end-to-end: typing shows the dropdown, Enter navigates, create-row POSTs and navigates.
