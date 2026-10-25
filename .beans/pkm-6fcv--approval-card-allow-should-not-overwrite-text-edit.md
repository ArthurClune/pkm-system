---
# pkm-6fcv
title: 'Approval card: Allow should not overwrite text edited after the card showed it'
status: in-progress
type: feature
priority: normal
created_at: 2026-10-24T23:30:51Z
updated_at: 2026-10-25T15:08:18Z
parent: pkm-mfd0
---

From the pkm-g2w9 plan (2026-10-25). The approval card now shows each update/move/delete target's current text, read when the confirm request is built. But it is not a guard: update_block's hash guard is computed when the tool runs, not from the text the card showed, so a block edited while the card is open (the editor sits beside the panel) is overwritten on Allow; a batch update has no guard at all.

Needs Arthur's call: pass the shown text's hash into the tool so Allow applies only if the block still matches what was shown (else refuse or re-show the card).

- [x] Decide: guard Allow on the shown text, or accept — Arthur 2026-10-25: guard. Allow refuses when a shown block was edited after the card showed it (decisions spec row, on security/batch-server until it merges)
- [ ] If guarded: hash carried from preview to apply for update_block and batch update/move/delete
