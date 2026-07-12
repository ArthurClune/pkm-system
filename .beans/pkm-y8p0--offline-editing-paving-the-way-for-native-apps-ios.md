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
- [x] Written implementation plan, broken into child beans

## Plan & child beans (2026-07-12)

Server-phase plan: docs/superpowers/plans/2026-07-12-offline-sync-server.md
(covers pkm-dnl6). Web phases get their own plans when unblocked.

- pkm-dnl6 — server: journal, feed/snapshot, nudges, batch_id, conflicts, create_page
- pkm-gtov — web: sqlite-wasm replica worker + bootstrap + feed (blocked by dnl6)
- pkm-su05 — web: persisted queue, optimistic apply, TS refs, page-id reconciliation (blocked by gtov)
- pkm-wptk — web: apiFetch offline router + shim + indicator (blocked by su05)
- pkm-blz2 — web: offline FTS5 search (blocked by wptk)
- pkm-xnnh — web: service worker app shell + asset cache + manifest (blocked by wptk)

Review guardrails to carry into web plans: schema recovery reads the pending
queue before any teardown (pending_ops stays extractable by newer clients);
WS nudge strictly post-commit, failed send drops the connection (catch-up
pull recovers).

## Design decisions (2026-07-12)

Approved design: docs/superpowers/specs/2026-07-12-offline-editing-design.md

- Scenarios: laptop-on-train (primary), phone capture (protocol-ready, implementation deferred). Network present ⇒ Tailnet reachable (offline is a clean binary).
- Conflicts: per-block LWW + conflict-copy sibling blocks (nothing silently lost); CRDT rejected.
- Client: full-graph replica in sqlite-wasm (opfs-sahpool), schema exported from schema.py; offline reads via an apiFetch-level "local API shim" returning the same OpenAPI shapes (views untouched); persisted op queue inside the replica DB.
- Sync: state-based changes feed (`/api/sync/changes?since=` windowed over raw journal rows, `/api/sync/snapshot`), not op replay; journal maintained by row-level triggers so derived changes (sibling shifts, subtree moves, cascade deletes, implicit pages) are captured. WS gains a seq nudge.
- Conflict detection via `base_text_hash` on update_text (no version column — avoids false conflicts from structural changes and avoids ALTER TABLE); pushes idempotent via `batch_id` dedup; orphaned edit-vs-delete text lands on today's daily page; offline-created pages use negative temp ids remapped on sync.
- Offline in v1: read everything, edit, backlinks, FTS5 search, page/daily create, viewed-assets cache (LRU). Deferred: offline asset upload, full 2GB asset sync, offline query blocks, sidebar writes, PWA/iOS.
