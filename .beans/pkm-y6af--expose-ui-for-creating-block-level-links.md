---
# pkm-y6af
title: Expose UI for creating block-level links
status: todo
type: feature
created_at: 2026-07-11T20:37:00Z
updated_at: 2026-07-11T20:37:00Z
---

Block-level linking works for blocks imported from the graph, but there is no UI to create NEW block-level links from within the app. Need a way to reference/link to a specific block (e.g. a ((block-ref)) style autocomplete, a 'copy block reference' action on the block menu, or both) so users can create block links natively.

Checklist:
- [ ] Decide UX for creating a block link (trigger syntax and/or block context-menu action)
- [ ] Implement block reference insertion
- [ ] Render/navigate the new links the same as imported ones
