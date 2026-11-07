---
# pkm-lh8r
title: 'Outline: keys pressed in the bullet menu also run as block-selection commands'
status: todo
type: bug
priority: high
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-07T18:42:45Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review findings outline F1 and F9 (pruning part). Verdict: HOLDS,
reproduced in vitest.

## Symptom
Select blocks (Shift+Down), click a bullet to open its menu, then press:
Tab → the selected blocks indent; Backspace/Delete → they are deleted;
ArrowDown → the selection is cleared, no block is edited, the menu stays
open; Escape also clears the selection. Arrows are the natural way to move
through the menu.

## Cause
`EditableBlockTree.tsx` `onKeyDown` gates only on `selection` being
non-null. BlockMenu is portalled but its React parent is the tree, so its
keydowns bubble through the tree's handler into `decideSelectionKey`.
Separately (F9), the selection is never validated against the tree, so a
selection whose anchor/head is gone keeps selection mode alive.

## Fix
- [ ] Red tests: menu open + selection, for Tab, Backspace, ArrowDown, Escape
- [ ] Ignore keydowns whose target is outside the tree's own DOM (`currentTarget.contains(target)`), which also covers the ref popover and picker
- [ ] Prune the selection in `adoptShared` when its blocks are gone, and clear it wherever focus is set
