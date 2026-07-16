---
# pkm-kbv5
title: Render Roam {{table}} imports as Markdown tables
status: in-progress
type: bug
priority: normal
created_at: 2026-07-16T20:47:29Z
updated_at: 2026-07-16T20:55:44Z
---

Roam imports on [[AI Pricing]] contain {{table}} blocks that should render as Markdown tables, but currently do not. Use the recent PDF import work as the reference pattern.

## Checklist

- [x] Reproduce the AI Pricing table failure and identify the root cause
- [ ] Add a focused regression test and confirm it fails
- [ ] Implement the minimal frontend table renderer
- [ ] Add the `/table` creation command
- [ ] Run focused and full verification
- [ ] Commit, push, merge with --no-ff, and push main
- [ ] Document the result and complete the bean

## Root Cause

The importer correctly preserves Roam table trees. The frontend only recognizes query and PDF macros, so `{{[[table]]}}` renders as literal text and its descendants remain outline blocks. AI Pricing has five such macros; globally the imported graph has 31. A Roam table is represented as direct-child rows whose first-child chain contains the row cells.
