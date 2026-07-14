---
# pkm-7t7o
title: Render tags and attributes as metadata chips
status: in-progress
type: feature
priority: normal
created_at: 2026-07-14T20:06:28Z
updated_at: 2026-07-14T20:34:37Z
parent: pkm-heod
---

The literal "Tags::" label + bold text looks like unrendered markup, and it repeats in every backlink card ("Tags:: #Paper #AGI ..." over and over on AGI's backlinks section).

- [x] Render attribute name ("Tags") as a small-caps muted label instead of bold text + "::"
- [x] Render #tags as small rounded chips (subtle bg, muted text, hover -> link colour)
- [x] Applies in both main outline and backlink cards
- [x] Keep raw text form when the block is being edited (textarea shows source)
- [ ] Verify on AGI backlinks (worst case: many tag-only cards) in both themes
