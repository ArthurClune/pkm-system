---
# pkm-713t
title: 'Outline autocomplete: Enter picks while the outline is read-only, and an unclamped highlight throws'
status: completed
type: bug
priority: low
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-08T15:00:12Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review findings outline F5 and F8. Verdict: HOLDS (both).

- F5: `decideEditorKey` checks `acRowsLength > 0` before the `readOnly` cut,
  and `BlockInput.decideKey` passes `acLive ? acRows.length : 0` regardless of
  `readOnly` (the popup is only hidden). An open popup when `canEdit` turns
  false (socket down, replica not ready) still takes Enter/Tab, and the pick
  enqueues an edit to a read-only outline.
- F8: the highlighted row index is not clamped when rows shrink
  asynchronously (`useTitleOptions` keeps old options until the 150 ms
  debounced fetch); Enter then calls `pick(undefined)` and throws a TypeError.

- [x] Red tests for both
- [x] `acLive && !readOnly`
- [x] Clamp `selected` to the current row count at pick time

## Summary of Changes

`BlockInput.decideKey` tells the policy the popup is closed while `readOnly`, so Enter and Tab no longer pick into a read-only outline. The highlight is clamped to the rows shown (`acSelected`) for the policy, the pick and the popup, so title rows shrinking under it after a late fetch pick the last row instead of throwing. Tests: `BlockInput.test.tsx` "an open popup".
