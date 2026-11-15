---
# pkm-b1x2
title: Blocks view shows a nested result's parent line
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T16:34:36Z
parent: pkm-l79g
---

Task 2 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.

## Summary of Changes

Query blocks view now renders each nested result's ancestor trail as `.query-crumb` links (joined with ›) above the item. Click navigates to the group page at the ancestor uid; shift-click opens the sidebar, as BlockRef does. Added QueryGroup to api/payloads.ts and a .query-crumb style. styling.md lists no link/crumb classes, so it is unchanged.
