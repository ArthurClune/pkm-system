---
# pkm-4ubd
title: Online-only sessions post update_text without base_text_hash, losing conflict protection
status: todo
type: bug
priority: normal
created_at: 2026-08-04T12:20:27Z
updated_at: 2026-08-04T12:20:27Z
---

Found by adversarial review of pkm-bjae (verified by capturing the real POST body in a provider test).

`base_text_hash` is stamped **inside the worker** -- `web/src/replica/queue.ts:41-47` fills it from `currentText(db, uid)` when the op arrives with `base_text_hash === undefined`. No editor path supplies one: grep `op: "update_text"` finds outline/edits.ts, outline/useOutline.ts, outline/history.ts, outline/outlineState.ts, outline/paste.ts -- none set it (only components/UnlinkedSection.tsx does).

So any op that never reaches the database goes to the server unguarded. That is every op in a session whose replica could not be opened (pkm-bjae's online-only fallback), because those ride the in-memory fallback lane, which posts `head.ops` verbatim.

Captured POST body from such a session:

    {"client_id":"...","batch_id":"...","ops":[{"op":"update_text","uid":"block-1","text":"edited online-only"}]}

Server consequences (`server/src/pkm/server/ops_core.py`):
- `:225` `if op.base_text_hash is None: return base_effects` -> plain LWW. A concurrent edit to the same block from the tab that DOES own the replica is overwritten outright; the loser-preserved-as-`[[conflict]]`-sibling path never runs. Unrecoverable text loss.
- `:206-217` the edit-vs-delete conflict path is also gated on the hash being present, so without it `:219` raises OpError("block not found") -> HTTP 400. In the fallback lane a 4xx DISCARDS the whole entry and raises the barrier.

This matters because "two tabs open is normal, so read-only would be a daily tax" is the load-bearing argument for pkm-bjae's online-only decision -- and this is that decision's cost. In an online-only session NOTHING is conflict-guarded, including the one op that normally is.

Fix: stamp `base_text_hash` on the main thread at op-construction time (the editor has the pre-edit `node.text`). The worker already defers to it -- `replica/queue.ts:41` only fills the hash in when `undefined` -- so this is additive, not a change of ownership.

## Checklist

[ ] Stamp base_text_hash where update_text ops are built (edits.ts, useOutline.ts, history.ts, outlineState.ts, paste.ts)
[ ] Confirm the worker still defers (no double-hashing, no stale-hash override)
[ ] Cover: an online-only session's update_text POST carries a hash
[ ] Cover: two-tab concurrent edit yields a [[conflict]] sibling rather than a silent overwrite
[ ] Update docs/architecture/sync-and-offline.md (the fallback-lane payload note added by pkm-bjae)
