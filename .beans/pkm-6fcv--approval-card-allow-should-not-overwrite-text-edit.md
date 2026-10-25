---
# pkm-6fcv
title: 'Approval card: Allow should not overwrite text edited after the card showed it'
status: completed
type: feature
priority: normal
created_at: 2026-10-24T23:30:51Z
updated_at: 2026-10-25T17:04:04Z
parent: pkm-mfd0
---

From the pkm-g2w9 plan (2026-10-25). The approval card now shows each update/move/delete target's current text, read when the confirm request is built. But it is not a guard: update_block's hash guard is computed when the tool runs, not from the text the card showed, so a block edited while the card is open (the editor sits beside the panel) is overwritten on Allow; a batch update has no guard at all.

Needs Arthur's call: pass the shown text's hash into the tool so Allow applies only if the block still matches what was shown (else refuse or re-show the card).

- [x] Decide: guard Allow on the shown text, or accept — Arthur 2026-10-25: guard. Allow refuses when a shown block was edited after the card showed it (decisions spec row, on security/batch-server until it merges)
- [x] If guarded: hash carried from preview to apply for update_block and batch update/move/delete

## Summary of Changes

When the approval card is built, the server records one expectation per block it shows: the full stored text's hash (updates, moves), the hash of the whole subtree (deletes, matching the card's "and N blocks under it"), or absent. On Allow, `can_use_tool` returns the carded input plus these as `expect` through `PermissionResultAllow.updated_input`; the in-app pkm-mcp subprocess runs in a require-expect mode (fails closed without it) and forwards `OpBatch.expect`; `/api/ops` checks it inside the write transaction after the batch-id dedupe and refuses the whole batch with 412. A model-supplied `expect` is refused at the card; the browser never sees the hashes. External pkm-mcp/CLI callers are unchanged. Live harness check: an edit made while the card was open → Allow refused with 412, the block kept the edit. Docs: assistant.md, backend.md, cli-and-mcp.md, a troubleshooting row.
