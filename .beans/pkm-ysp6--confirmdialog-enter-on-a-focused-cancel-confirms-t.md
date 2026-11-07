---
# pkm-ysp6
title: 'ConfirmDialog: Enter on a focused Cancel confirms the destructive action'
status: completed
type: bug
priority: high
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-07T21:03:39Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding webui F5. Verdict: HOLDS, reproduced in real Chromium
and WebKit.

## Symptom
Tab to Cancel and press Enter: the action is confirmed. This dialog guards
Delete page, Delete files and "Discard and reload" (loses unsent changes).
Plain Safari skips buttons on Tab by default, so this mostly bites in Chrome
or with full keyboard access on.

## Cause
`components/ConfirmDialog.tsx` `useConfirm`: a window keydown listener maps
Enter to `settle(true)` regardless of focus; its bubble-phase
`preventDefault()` suppresses the focused button's own activation. Also
(harmless today): a second `confirm()` replaces a pending state without
resolving the first promise.

## Fix
- [x] Red test with focus on Cancel (existing tests fire Enter on window without focus)
- [x] Let a focused button handle Enter (ignore Enter when the target is a button)
- [x] Settle a pending confirm as false before replacing it

## Summary of Changes

- `useConfirm`'s `window` keydown listener leaves Enter alone when its target
  is a button inside the dialog, so a focused Cancel cancels and a focused
  confirm button confirms through its own click.
- `confirm()` resolves a still-pending confirmation `false` before replacing
  it.
- Tests in `ConfirmDialog.test.tsx`: "Enter on a focused Cancel button cancels
  instead of confirming", "Enter on the focused confirm button confirms once",
  "a second confirm() settles the pending one as false".
- `frontend.md` § Popovers and menus row and a troubleshooting row.
