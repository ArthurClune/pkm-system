---
# pkm-4ubd
title: Online-only sessions post update_text without base_text_hash, losing conflict protection
status: todo
type: bug
priority: normal
created_at: 2026-08-04T12:20:27Z
updated_at: 2026-08-04T12:54:50Z
parent: pkm-q2jj
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


## Ready-made repro (from the pkm-bjae adversarial review, run verbatim at 4fe2886)

NOT committed as a test file: as written it passes (it only asserts one POST happened) and the missing hash shows in the logged body. To make it a real pin, change the final assertion to `expect(bodies[0].ops[0]).toHaveProperty("base_text_hash")`, which fails until the hash is stamped main-thread-side. Commit it green, with that assertion, as part of the fix.

The open-failure message is deliberately the SAH-contention string, i.e. the *working* online-only path where the lane does deliver. That is what makes the missing hash a property of the fallback lane itself rather than a side effect of a broken session.

```tsx
const bodies: unknown[] = [];
vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/ops") { bodies.push(JSON.parse(String(init?.body))); return jsonResponse({ ok: true }); }
  if (url === "/api/sync/snapshot") return jsonResponse(SNAPSHOT);
  if (url.startsWith("/api/sync/changes")) return jsonResponse(EMPTY_FEED);
  return jsonResponse({ detail: "not found" }, 404);
}));
// replica: init resolves { ok: false, ... }; every other handler rejects with
// "Access Handles cannot be created if there is another open Access Handle"
// (SyncProvider.test.tsx's unopenableReplica() already has this shape)
render(<SyncProvider replica={replica}><Grab /></SyncProvider>);
await act(async () => { lastWs().open(); await Promise.resolve(); });
await vi.waitFor(() => { expect(sync.replicaMode).toBe("no-replica"); });
await act(async () => {
  sync.enqueue([{ op: "update_text", uid: "block-1", text: "edited online-only" }]);
});
await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
expect(bodies[0].ops[0]).toHaveProperty("base_text_hash");   // <- the pin
```

Observed body at 4fe2886 — note the absent hash:

    {"client_id":"...","batch_id":"...",
     "ops":[{"op":"update_text","uid":"block-1","text":"edited online-only"}]}
