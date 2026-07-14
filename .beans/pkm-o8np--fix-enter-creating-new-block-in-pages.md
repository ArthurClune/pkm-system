---
# pkm-o8np
title: Fix Enter creating new block in pages
status: completed
type: bug
priority: normal
created_at: 2026-07-14T20:36:43Z
updated_at: 2026-07-14T20:47:33Z
---

Pressing Enter in a page block should create a new block ready for typing, but currently the UI judders and returns focus/caret to the previous line.

## Debug checklist
- [x] Reproduce the regression consistently (unit baseline does not catch it; moving to browser/built-app reproduction)
- [x] Identify the recent change/root cause: same-page refetches could adopt stale initial blocks while a local split/create op was still draining, removing the optimistic new block
- [x] Add a failing regression test
- [x] Implement the root-cause fix
- [x] Run focused and required verification

## Summary of Changes

- Added a regression test covering stale same-page initial rerenders during an in-flight Enter split.
- Guarded `useOutline` from adopting stale parent `initial` blocks while local optimistic writes are still draining through `sync.idle()`.
- Verified with focused unit tests, built-app browser check, and `cd web && pnpm verify`.
