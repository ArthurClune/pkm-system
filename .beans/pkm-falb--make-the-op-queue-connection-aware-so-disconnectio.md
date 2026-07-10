---
# pkm-falb
title: Make the op queue connection-aware so disconnection really pauses writes
status: completed
type: bug
priority: high
created_at: 2026-07-10T10:56:52Z
updated_at: 2026-07-10T11:45:22Z
parent: pkm-m309
---

Review finding 3 (Important). The UI goes read-only when WebSocket status !== connected, but the op queue has no connection state: SyncProvider (web/src/sync/SyncProvider.tsx:52-89) always exposes enqueue -> queue.enqueue (web/src/sync/opQueue.ts:22-72), which pumps HTTP immediately. Async work started while connected can still POST after the socket drops: a 500ms text debounce firing post-disconnect, an image upload completion creating update_text, or a structural op already in flight crossing the transition. This violates the design invariant (docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md:117-120) that disconnection pauses writes so divergence is impossible. Related paths: web/src/outline/useOutline.ts:42-100 and :180-203.

Fix direction: give the queue explicit connectivity state. When offline, preserve pending ops/drafts without sending; on reconnect, establish the authoritative-state policy first, then flush safe pending work or discard it with explicit user-visible reconciliation. Do NOT silently drop enqueue() calls — that is direct data loss.

## Checklist
- [x] Thread connection status into opQueue; stop pumping while offline
- [x] Preserve pending ops/drafts while offline
- [x] Define and implement reconnect policy (authoritative state, then flush or explicit reconciliation)
- [x] Regression: type text, disconnect before debounce, advance timer → no HTTP POST
- [x] Regression: upload completes after disconnection → no op pumped
- [x] Regression: reconnect → documented handling of preserved pending work
- [x] Regression: in-flight POST whose socket drops before the response

## Implementation notes

`opQueue` gains `setOnline(bool)`, driven by `SyncProvider` from the websocket
status. Offline, `enqueue()` still preserves ops (no silent drop) but `kick()`
starts no pump; `pump()` re-checks `online` each iteration so an in-flight POST
finishes while no new batch is sent. Reconnect calls `setOnline(true)` (flushes
preserved ops, which become the newest server-LWW writers) and defers the
`resyncSeq` bump behind `queue.idle()` so views refetch *post-flush* authoritative
state — avoiding a display-vs-server divergence the literal "refetch then flush"
ordering would create. A failed flush keeps the existing clear-pending + desync
path. Tests: web/src/sync/opQueue.test.ts (offline/reconnect/in-flight),
web/src/sync/connectionAware.test.tsx (debounce + upload regressions),
web/src/sync/SyncProvider.test.tsx (flush-before-resync ordering).

## Summary of Changes

- opQueue gains explicit online state (setOnline driven by SyncProvider's WS status): offline enqueues are preserved, never dropped, and no new HTTP pump starts; in-flight POSTs complete normally.
- Reconnect flushes preserved ops, then a queue.idle()-gated resync bump refetches authoritative state (flush-then-refetch, chosen over refetch-then-flush to avoid the refetch racing the flush POST and adopting pre-flush state).
- 7 new tests covering all four regression scenarios (debounce-after-drop, upload-after-drop, ordered reconnect flush, in-flight crossing); 262 web tests + typecheck pass. Merged to main (--no-ff).
- Deferred minors (final-review triage): redundant double refetch when the reconnect flush fails; second-disconnect-mid-flush releases the gated refetch early (self-heals); test (b) preservation assertion could be tighter. Pre-existing policy note: flush failure at reconnect still clears pending via the desync path (visible revert, not silent loss).
