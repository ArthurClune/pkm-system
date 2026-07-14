---
# pkm-q010
title: Reduce outline line spacing to 1.4
status: completed
type: task
priority: normal
created_at: 2026-07-14T15:34:02Z
updated_at: 2026-07-14T15:35:52Z
---

Tighten the outline line spacing from the pkm-umvr 1.6 setting to 1.4.

Checklist:
- [x] Confirm affected CSS selectors
- [x] Update line-height values to 1.4
- [x] Run focused verification
- [x] Summarize and complete

## Summary of Changes

Reduced outline line-height from 1.6 to 1.4 for `.block-row` and `.bullet.numbered`, and added a focused CSS regression test for the expected spacing.
