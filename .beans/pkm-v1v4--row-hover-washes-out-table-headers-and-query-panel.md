---
# pkm-v1v4
title: Row hover washes out table headers and query panels
status: completed
type: bug
priority: normal
created_at: 2026-11-16T08:35:41Z
updated_at: 2026-11-16T08:41:31Z
---

Hovering an outline row fills it with --color-bg-subtle, the same token as table headers, the filter panel, query cards and code blocks, so a hovered table/query block (always hovered while editing) loses its header and panels into the row fill.

- [x] Own --color-row-hover token, lighter than --color-bg-subtle, in all three theme rules
- [x] DataTable cells sit on --color-bg-surface so a hovered row does not tint the table
- [x] styling.md states the rule
- [x] Visual check light + dark
- [x] pnpm verify

## Summary of Changes

Symptom: hovering (or editing in) a `{{table}}` or query block filled the whole row with the same grey as the table header, filter field and query panel, so they vanished into it. Cause: `.block-row:hover` used `--color-bg-subtle`, the fill those elements use. Fix: a separate `--color-row-hover` token (lighter in light mode; in dark it lifts above the surface instead of sinking toward the subtle fill), and `.data-table td` / `.roam-table td` are opaque on `--color-bg-surface`. Rule stated in docs/architecture/styling.md § Block row layout and § Controls (Tables).
