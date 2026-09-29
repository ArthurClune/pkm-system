---
# pkm-b0zf
title: Windowed reapply rolls back a pending batch whose create already applied
status: completed
type: bug
priority: normal
created_at: 2026-09-29T08:21:14Z
updated_at: 2026-09-29T09:54:50Z
---

Found while doing pkm-7788. `reapplyPending` (web/src/replica/apply.ts) replays every pending batch from scratch after each feed window. A windowed `applyChanges` does not wipe the optimistic rows first, so a pending `create` hits the uid PRIMARY KEY: its block is already there from the enqueue-time apply. `applyLocalOps` throws, and the savepoint rolls the WHOLE batch back for that window.

Consequence: pending batch [create C, update_text L → "mine"]. A window that re-ships L with other text (e.g. another device's edit landing before our ack) leaves L at the feed's text until our ack or echo. A follow-up local edit to L in that gap hashes against that text. This is the same spurious-conflict window pkm-7788 closed for missing targets, reached through a create instead. Snapshots are unaffected, because they wipe first. Confirmed with a standalone probe during pkm-7788 (not committed).

Options to weigh:
- In reapply only, treat a create whose uid already exists as already applied: update its row in place, or skip the insert and fall through. The enqueue-time apply must keep failing on a real collision, since the server 400s it.
- Make reapply idempotent more broadly. Moves re-run `shiftSiblings` on every window, which drifts sibling order_idx (relative order survives).

- [x] Failing test in apply.test.ts: windowed applyChanges re-shipping L while [create C, update_text L] is pending keeps L's optimistic text
- [x] Fix
- [x] sync-recovery.md § Recovery never erases intent, if the reapply contract changes

## Summary of Changes

- `applyLocalOps` takes `{ reapply }`; `reapplyPending` passes it. On replay a create whose uid exists is treated as its own effect (enqueue-time apply or the server's echo) and kept, not re-inserted; a move whose block already sits at its target is kept too. Both go through `keepSlot`, which shifts siblings only when one the window re-shipped at its server index shares the block's slot. Enqueue-time apply is unchanged, so a real collision still throws.
- Skip rather than overwrite: the row's presence proves the create took effect, later ops in the queue re-apply over it, and overwriting order_idx would either tie with a re-shipped sibling or (with a shift) drift siblings per window.
- The move change removes per-window order_idx drift for a block that sits where its pending move put it. Remaining gap: a window re-shipping a subset of siblings at server indices into a list in locally-shifted indices can still tie; fixing that needs undoing pending effects before the upsert.
- Tests in apply.test.ts (create keeps batch; own echo; re-shipped sibling on the slot; no drift across windows for create and move; drifted sibling overtaken). Docs: sync-recovery.md § Recovery never erases intent gains a guard row and a paragraph; reapplyPending comment updated.

