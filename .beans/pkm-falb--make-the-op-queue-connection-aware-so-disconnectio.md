---
# pkm-falb
title: Make the op queue connection-aware so disconnection really pauses writes
status: todo
type: bug
priority: high
created_at: 2026-07-10T10:56:52Z
updated_at: 2026-07-10T10:57:50Z
parent: pkm-m309
---

Review finding 3 (Important). The UI goes read-only when WebSocket status !== connected, but the op queue has no connection state: SyncProvider (web/src/sync/SyncProvider.tsx:52-89) always exposes enqueue -> queue.enqueue (web/src/sync/opQueue.ts:22-72), which pumps HTTP immediately. Async work started while connected can still POST after the socket drops: a 500ms text debounce firing post-disconnect, an image upload completion creating update_text, or a structural op already in flight crossing the transition. This violates the design invariant (docs/superpowers/specs/2026-07-08-roam-migration-pkm-design.md:117-120) that disconnection pauses writes so divergence is impossible. Related paths: web/src/outline/useOutline.ts:42-100 and :180-203.

Fix direction: give the queue explicit connectivity state. When offline, preserve pending ops/drafts without sending; on reconnect, establish the authoritative-state policy first, then flush safe pending work or discard it with explicit user-visible reconciliation. Do NOT silently drop enqueue() calls — that is direct data loss.

## Checklist
- [ ] Thread connection status into opQueue; stop pumping while offline
- [ ] Preserve pending ops/drafts while offline
- [ ] Define and implement reconnect policy (authoritative state, then flush or explicit reconciliation)
- [ ] Regression: type text, disconnect before debounce, advance timer → no HTTP POST
- [ ] Regression: upload completes after disconnection → no op pumped
- [ ] Regression: reconnect → documented handling of preserved pending work
- [ ] Regression: in-flight POST whose socket drops before the response
