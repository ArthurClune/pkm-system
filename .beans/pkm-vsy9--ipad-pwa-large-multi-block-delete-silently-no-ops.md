---
# pkm-vsy9
title: 'iPad PWA: large multi-block delete silently no-ops (window.confirm)'
status: todo
type: bug
created_at: 2026-07-31T16:29:48Z
updated_at: 2026-07-31T16:29:48Z
---

Side finding from pkm-6phf planning (not part of the epic).

**References:** web/src/outline/useOutline.ts:407-411

useOutline uses window.confirm to confirm a large multi-block delete. On the iPad PWA window.confirm is suppressed and returns undefined, so !window.confirm(...) is truthy and the delete silently no-ops. Should use the existing useConfirm mechanism (same fix as prior iPad confirm bugs).

- [ ] Replace window.confirm with useConfirm in the multi-block delete path
- [ ] Add a regression test
