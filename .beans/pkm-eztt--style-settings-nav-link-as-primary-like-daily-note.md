---
# pkm-eztt
title: Style Settings nav link as primary like Daily Notes
status: completed
type: task
priority: normal
created_at: 2026-07-26T21:02:20Z
updated_at: 2026-07-26T21:12:28Z
---

User request: the Settings link in the left sidebar should be styled to match the fixed primary links at the top (Daily Notes, Current Work, TODO), i.e. always accent-coloured. Reverses the deliberate non-primary styling from pkm-7myl. Position stays below the favourites.

- [x] Update App.test.tsx expectation (Settings has primary class)
- [x] Add primary class to Settings NavLink in App.tsx
- [x] Run web verification

## Summary of Changes

Added the `primary` class to the Settings NavLink in App.tsx so it is always accent-coloured like Daily Notes/Current Work/TODO (position unchanged, still below the favourites). Updated the App.test.tsx assertion from not-primary to primary. Full web verify green except pre-existing backlink-filter e2e flake (tracked as pkm-c9hp, reproduced on clean main).
