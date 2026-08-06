---
# pkm-3w2h
title: Keyboard focus management for block-menu and block-ref popovers
status: scrapped
type: task
priority: normal
created_at: 2026-08-06T12:05:26Z
updated_at: 2026-08-06T12:50:37Z
---

Final review of pkm-d31f: .block-menu and .block-ref-popover share the same keyboard gap — aria-haspopup without aria-expanded, popover renders at tree level so Tab from the trigger never reaches it, and nothing returns focus on close. A keyboard user can open either popover but not navigate it. Fixing focus management once (focus trap or roving focus + restore-on-close, aria-expanded on triggers) fixes both. Mirrors, not a regression: pkm-d31f copied the .block-menu precedent.

## Reasons for Scrapping

Arthur's call (2026-08-06): won't fix for now. Mouse/touch-only popovers are acceptable for a single-user app; not a regression (pkm-d31f mirrored the existing .block-menu behavior). Revive if keyboard/AT access ever matters — the shared-fix shape described above still applies.
