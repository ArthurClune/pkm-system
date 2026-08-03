---
# pkm-2jaz
title: Replace last window.confirm with useConfirm (convention)
status: completed
type: task
priority: low
created_at: 2026-08-01T18:22:44Z
updated_at: 2026-08-03T15:41:30Z
---

Successor to pkm-vsy9 (scrapped: the iPad PWA no-op stopped reproducing on current iPadOS — window.confirm works again there as of 2026-08-01). useOutline.ts:408 is still the one window.confirm outside the useConfirm mechanism; older iPadOS builds presumably still suppress it, and it is inconsistent with the app's confirm convention.

- [x] Replace window.confirm with useConfirm in the multi-block delete path
- [x] Add a regression test
