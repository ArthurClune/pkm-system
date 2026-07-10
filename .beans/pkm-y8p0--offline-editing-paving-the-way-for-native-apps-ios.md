---
# pkm-y8p0
title: Offline editing, paving the way for native apps (iOS)
status: todo
type: epic
created_at: 2026-07-10T16:37:01Z
updated_at: 2026-07-10T16:37:01Z
---

Support editing while offline, with changes syncing when connectivity returns. Architecture choices here should keep a future native iOS app in mind (local-first data layer, sync protocol usable outside the browser).

This is epic-scale: needs brainstorming and a written plan before any implementation. Likely areas:

- [ ] Requirements/brainstorm: offline scope (read-only cache vs full editing), conflict handling, multi-device expectations
- [ ] Evaluate approaches: service worker + local store (IndexedDB/SQLite-wasm), CRDT vs op-log replay, reuse of existing op queue (see pkm-falb for prior connection-aware op-queue work)
- [ ] Sync protocol design that a native (iOS) client could also speak
- [ ] Written implementation plan, broken into child beans
