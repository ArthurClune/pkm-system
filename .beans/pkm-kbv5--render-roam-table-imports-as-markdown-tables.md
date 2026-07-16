---
# pkm-kbv5
title: Render Roam {{table}} imports as Markdown tables
status: in-progress
type: bug
priority: normal
created_at: 2026-07-16T20:47:29Z
updated_at: 2026-07-16T21:50:45Z
---

Roam imports on [[AI Pricing]] contain {{table}} blocks that should render as Markdown tables, but currently do not. Use the recent PDF import work as the reference pattern.

## Checklist

- [x] Reproduce the AI Pricing table failure and identify the root cause
- [x] Add a focused regression test and confirm it fails
- [x] Implement the minimal frontend table renderer
- [x] Add the `/table` creation command
- [x] Run focused and full verification
- [ ] Commit, push, merge with --no-ff, and push main
- [ ] Document the result and complete the bean

## Root Cause

The importer correctly preserves Roam table trees. The frontend only recognizes query and PDF macros, so `{{[[table]]}}` renders as literal text and its descendants remain outline blocks. AI Pricing has five such macros; globally the imported graph has 31. A Roam table is represented as direct-child rows whose first-child chain contains the row cells.

## Summary of Changes

- Added a pure Roam table-tree converter with malformed-tree fallback and ragged-row padding.
- Rendered valid imported table macros as semantic, horizontally scrollable tables in read-only and editable outlines.
- Preserved raw source editing by revealing the macro subtree while its macro block is focused.
- Added `/table` to create an exact `{{table}}` macro.
- Verified server tests/typecheck/lint and the complete web verification suite.
