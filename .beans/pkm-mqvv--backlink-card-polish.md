---
# pkm-mqvv
title: Backlink card polish
status: in-progress
type: feature
priority: normal
created_at: 2026-07-14T20:06:28Z
updated_at: 2026-07-14T20:39:30Z
parent: pkm-heod
---

Backlink/query cards currently have both a border and a subtle background, generous padding, no hover state, and near-invisible breadcrumbs (--color-text-faint).

- [x] Tighten card padding; drop border in favour of just the subtle bg (or vice versa)
- [x] Add hover state (slightly stronger bg or border)
- [x] Make breadcrumb line legible (bump to --color-text-muted or larger)
- [x] Applies to .backlink-item and .query-item alike
