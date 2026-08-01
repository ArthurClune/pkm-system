---
# pkm-vsy9
title: 'iPad PWA: large multi-block delete silently no-ops (window.confirm)'
status: scrapped
type: bug
priority: normal
created_at: 2026-07-31T16:29:48Z
updated_at: 2026-08-01T18:22:51Z
---

Side finding from pkm-6phf planning (not part of the epic).

**References:** web/src/outline/useOutline.ts:407-411

useOutline uses window.confirm to confirm a large multi-block delete. On the iPad PWA window.confirm is suppressed and returns undefined, so !window.confirm(...) is truthy and the delete silently no-ops. Should use the existing useConfirm mechanism (same fix as prior iPad confirm bugs).

- [ ] Replace window.confirm with useConfirm in the multi-block delete path
- [ ] Add a regression test

## Reasons for Scrapping

Retested live on the iPad PWA 2026-08-01 (Arthur, real device): the large multi-block delete now shows the confirm dialog and proceeds — window.confirm is no longer suppressed on current iPadOS, so the reported no-op does not reproduce. No code change was made (useOutline.ts:408 still calls window.confirm); the platform behaviour changed. The convention-level cleanup (this is the last window.confirm outside useConfirm, and older iPadOS builds presumably still suppress it) is tracked in pkm-2jaz.
