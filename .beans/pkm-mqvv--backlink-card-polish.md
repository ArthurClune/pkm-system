---
# pkm-mqvv
title: Backlink card polish
status: completed
type: feature
priority: normal
created_at: 2026-07-14T20:06:28Z
updated_at: 2026-07-14T20:49:27Z
parent: pkm-heod
---

Backlink/query cards currently have both a border and a subtle background, generous padding, no hover state, and near-invisible breadcrumbs (--color-text-faint).

- [x] Tighten card padding; drop border in favour of just the subtle bg (or vice versa)
- [x] Add hover state (slightly stronger bg or border)
- [x] Make breadcrumb line legible (bump to --color-text-muted or larger)
- [x] Applies to .backlink-item and .query-item alike

## Summary of Changes

Backlink/query cards keep the subtle bg and drop the visible border (transparent border reserves layout), padding tightened to 6px 10px, hover → --color-selected-bg, breadcrumbs bumped from faint to muted. Verified on AGI (52 linked references) in both themes.
