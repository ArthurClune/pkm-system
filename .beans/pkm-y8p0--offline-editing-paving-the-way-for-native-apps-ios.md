---
# pkm-y8p0
title: Offline editing, paving the way for native apps (iOS)
status: in-progress
type: epic
created_at: 2026-07-10T16:37:01Z
updated_at: 2026-07-10T16:37:01Z
---

Support editing while offline, with changes syncing when connectivity returns. Architecture choices here should keep a future native iOS app in mind (local-first data layer, sync protocol usable outside the browser).

This is epic-scale: needs brainstorming and a written plan before any implementation. Likely areas:

- [x] Requirements/brainstorm: offline scope (read-only cache vs full editing), conflict handling, multi-device expectations
- [x] Evaluate approaches: service worker + local store (IndexedDB/SQLite-wasm), CRDT vs op-log replay, reuse of existing op queue (see pkm-falb for prior connection-aware op-queue work)
- [x] Sync protocol design that a native (iOS) client could also speak
- [ ] Written implementation plan, broken into child beans

## Design decisions (2026-07-12)

Approved design: docs/superpowers/specs/2026-07-12-offline-editing-design.md

- Scenarios: laptop-on-train (primary), phone capture (protocol-ready, implementation deferred). Network present ⇒ Tailnet reachable (offline is a clean binary).
- Conflicts: per-block LWW + conflict-copy sibling blocks (nothing silently lost); CRDT rejected.
- Client: full-graph replica in sqlite-wasm (opfs-sahpool), schema exported from schema.py; offline reads via an apiFetch-level "local API shim" returning the same OpenAPI shapes (views untouched); persisted op queue inside the replica DB.
- Sync: state-based changes feed (`/api/sync/changes?since=`, `/api/sync/snapshot`, per-block `version`, `base_version` on ops), not op replay. WS gains a seq nudge.
- Offline in v1: read everything, edit, backlinks, FTS5 search, page/daily create, viewed-assets cache (LRU). Deferred: offline asset upload, full 2GB asset sync, offline query blocks, sidebar writes, PWA/iOS.
