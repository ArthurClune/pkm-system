---
# pkm-b68q
title: Fix typography hierarchy
status: completed
type: feature
priority: high
created_at: 2026-07-14T20:06:09Z
updated_at: 2026-07-14T20:17:37Z
parent: pkm-heod
---

Heading blocks render nearly as large as the page title but in muted grey-blue, so "See Also"/"Todos" (h2.block-text, 1.6rem) look bigger yet less important than the 26px page title. h3 at weight 400 + secondary colour reads as disabled.

- [x] Scale block headings down: h1 ≈ 1.4rem, h2 ≈ 1.25rem, h3 ≈ 1.1rem (all clearly below page title)
- [x] Give h3 back some weight (≥500) instead of 400 + --color-text-secondary
- [x] Page title more presence: ~28px, slightly tighter letter-spacing, a bit more space below
- [x] Verify outline rhythm still reads well on AGI (deep nesting + headings)

## Summary of Changes

- Heading blocks rescaled: h1 1.8->1.4rem, h2 1.6->1.25rem, h3 1.4->1.1rem; h3 now weight 600 in body colour (was 400 + secondary, which read as disabled).
- Page title 26->28px with -0.01em letter-spacing and 16px bottom margin, so the page keeps one visual root.
- Checked on AGI (deep nesting + headings) and Daily Notes in both themes.
