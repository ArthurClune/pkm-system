---
# pkm-5fak
title: Reconnect refetches only what changed; Journal stops N+1 fetching days
status: todo
type: bug
priority: high
created_at: 2026-09-01T21:26:51Z
updated_at: 2026-09-01T21:27:09Z
parent: pkm-fgjg
---

Tier 1 — the heart of the train symptom. Two coupled changes.

## Symptom
On a flapping link, every successful WS reconnect issues exactly one `GET /api/sync/changes` plus a full view refetch, even when the gap was 2 s and nothing changed. On the Journal the refetch is one `GET /api/page/<date>` per loaded day. Measured: 12 flaps/min → 24 req/min at 3.4% CPU on a small graph; with 20-30 journal days loaded each flap is ~30 requests + ~30 full-tree React passes.

## Where
- `web/src/sync/reconnectFlow.ts:40-54` — `finish()` runs `replicaSync.start()` + `onResync()` after any `"drained"` outcome; an empty queue still returns `"drained"` (`web/src/sync/opQueue.ts:491-499`).
- `web/src/sync/SyncProvider.tsx:511` — `onResync` bumps `resyncSeq`.
- `web/src/views/Journal.tsx:187-193` — `useResync` → `reset()` → `loadMore("resync")` for every already-loaded day; each day is its own `GET /api/page/<date>` (measured 27 per scroll of 40 wheel steps, 157 req/min).
- `web/src/views/PageView.tsx:28`, `web/src/views/CurrentWork.tsx:25` — the other `useResync` consumers.

## Ideas
- Bump `resyncSeq` only when the reconnect mattered: the pull advanced the cursor, or the drain delivered something. A 2 s blip with nothing on either side should cost one changes pull and no refetch.
- Journal: batch endpoint (or hydrate days from `/api/journal`'s payload) so N days ≠ N requests; on resync refetch only days the changes window actually touched (the replica knows which pages changed).
- Keep the invariant from sync-and-offline.md: "drain first, then pull, then refetch views" — this narrows *whether* to refetch, not the order.

## Verify
Re-run `ws-probe.mjs` (flapping window): changes-pulls per reconnect stays 1.0, page refetches per reconnect drops to 0 when nothing changed. Re-run scenario I: `/api/page` requests per journal scroll ≈ 0 or 1 batch. Update `docs/architecture/sync-and-offline.md` (resyncSeq description in Ancillary details) and `backend.md` API table if a route is added.

## Checklist
- [ ] Reproduce with a unit test: empty drain + no cursor advance must not call onResync
- [ ] Journal day loading no longer N+1
- [ ] Journal resync refetches only changed days
- [ ] Re-measure with ws-probe.mjs / perf.mjs scenario I
- [ ] Architecture docs updated
