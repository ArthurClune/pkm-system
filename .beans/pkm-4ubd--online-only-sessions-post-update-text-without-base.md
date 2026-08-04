---
# pkm-4ubd
title: Online-only sessions post update_text without base_text_hash, losing conflict protection
status: completed
type: bug
priority: normal
created_at: 2026-08-04T12:20:27Z
updated_at: 2026-08-04T17:19:55Z
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

[x] Stamp base_text_hash where update_text ops are built
[x] Confirm the worker still defers (no double-hashing, no stale-hash override)
[x] Cover: an online-only session's update_text POST carries a hash
[x] Cover: two-tab concurrent edit yields a [[conflict]] sibling rather than a silent overwrite
[x] Update docs/architecture/sync-and-offline.md (the fallback-lane payload note added by pkm-bjae)

## How it was closed

**Two choke points, not five files.** The checklist listed edits.ts, history.ts,
outlineState.ts and paste.ts, but those are all pure planners whose ops funnel
through `useOutline.run` — they never reach `sync.enqueue` on their own. Every
main-thread `update_text` therefore passes through exactly two places, and both
now call the new Functional Core `web/src/outline/baseTextHash.ts`:

- `useOutline.run` — stamps against `pre`, the pre-flush tree the whole batch
  (textOps + result.ops) grew from.
- `undoManager.dispatch` — stamps against the mounted session's tree *at replay
  time*. History records UNSTAMPED ops on purpose: a hash captured when the
  entry was recorded is stale by replay time and would fork a spurious
  `[[conflict]]` sibling against the user's own later edit.

`components/UnlinkedSection.tsx` already stamped its own hash and needed no
change; `dnd/DndContext.tsx` sends only move ops. There is no third site.

**The worker still defers.** `replica/queue.test.ts` is byte-for-byte unchanged
and all 11 tests still pass — `queue.ts:41` fills the hash in only when
`undefined`, so there is no double hashing and no stale-hash override.

**The [[conflict]]-sibling half is pinned server-side**, so no two-tab Playwright
test was built. The fork:

- `server/tests/test_ops_core.py:262` `test_check_5_stale_hash_wins_and_preserves_loser_as_sibling`
  (pure planner: incoming wins, loser becomes `[[conflict]] <old text>` right after the target)
- `server/tests/test_ops_endpoint.py:338` `test_conflict_copy_lands_next_to_target` (end-to-end HTTP)
- `server/tests/test_ops_apply.py:361` `test_conflict_sibling_uid_retries_until_alphanumeric_first_char`
- edit-vs-delete: `server/tests/test_ops_core.py:232` `test_check_1_missing_block_lands_on_daily_page`
  and `server/tests/test_ops_endpoint.py:367` `test_orphaned_edit_lands_on_todays_daily_page`

The no-hash LWW fallback this bug was falling into:

- `server/tests/test_ops_core.py:249` `test_check_3_absent_hash_applies_as_today` — the exact
  "returns early into plain last-write-wins" path
- `server/tests/test_ops_endpoint.py:384` `test_hashless_update_on_missing_block_still_400s` — the
  hashless edit-vs-delete 400 that made the fallback lane discard the entry
- `server/tests/test_ops_endpoint.py:352` `test_no_false_conflict_after_structural_change`

Both halves already existed; nothing was missing server-side, so no server test
was added.

**Finding: the brief's module did not compile.** `needsHash` was typed
`(op: BlockOp): boolean`, which never narrows `op`, so `op.uid` failed —
`create_page` carries no `uid`. It is a type predicate (`op is UpdateTextOp`)
instead, which also removes the `as UpdateTextOp` cast the brief needed.


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


## Residual hole found during final fix wave (2026-08-04, pkm-q2jj)

The undoManager.ts fix (task 4 above) stamps base_text_hash for undo/redo
dispatched to a *mounted* outline session by peeking the tree. But
web/src/outline/undoManager.ts:93-106's `dispatch` falls back to unstamped
ops whenever `peekOutlineSession(title)` returns null -- and the comment
there used to say the worker fills the hash in "when the replica is
openable". That is false for an online-only session: the replica never
opens, so the worker never fills it in.

This is reachable, not hypothetical: undo/redo is a per-tab global across
pages (`dispatch` takes `entry.pageTitle` and calls `navigator?.(pagePath(title))`
when the page isn't mounted), and `peekOutlineSession` returns null once a
page's session has been released. So: edit page B, navigate to page A
(releasing B's session), press undo, in a tab whose replica never opened ->
an unguarded `update_text` for page B ships with no base_text_hash, exactly
the LWW-overwrite / conflict-fork-skip failure mode this bean already
describes for the direct-edit path.

Left unfixed (out of scope for the fix wave that found it): the comment at
undoManager.ts:93-106 now says so explicitly. A real fix would need to stamp
the hash from durable/cached page state rather than a live tree when no
session is mounted, which is a separate design question.
