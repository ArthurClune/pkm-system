---
# pkm-b68q
title: Fix typography hierarchy
status: todo
type: feature
priority: high
created_at: 2026-07-14T20:06:09Z
updated_at: 2026-07-14T20:06:09Z
parent: pkm-heod
---

Heading blocks render nearly as large as the page title but in muted grey-blue, so "See Also"/"Todos" (h2.block-text, 1.6rem) look bigger yet less important than the 26px page title. h3 at weight 400 + secondary colour reads as disabled.

- [ ] Scale block headings down: h1 ≈ 1.4rem, h2 ≈ 1.25rem, h3 ≈ 1.1rem (all clearly below page title)
- [ ] Give h3 back some weight (≥500) instead of 400 + --color-text-secondary
- [ ] Page title more presence: ~28px, slightly tighter letter-spacing, a bit more space below
- [ ] Verify outline rhythm still reads well on AGI (deep nesting + headings)
