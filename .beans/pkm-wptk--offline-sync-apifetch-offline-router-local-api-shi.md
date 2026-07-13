---
# pkm-wptk
title: 'Offline sync: apiFetch offline router + local API shim + status indicator'
status: completed
type: task
priority: normal
created_at: 2026-07-12T17:38:43Z
updated_at: 2026-07-13T20:32:18Z
parent: pkm-y8p0
blocked_by:
    - pkm-su05
---

Spec step 5 (section 4): offline routing in apiFetch to local handlers over the replica returning the same OpenAPI shapes - page (incl backlinks), unlinked, journal, titles, block-refs, page create (create_page op enqueue), sidebar read; daily auto-create locally; online-only errors for sidebar writes/page delete/query/assets upload; 'offline - N changes pending' indicator replaces the read-only banner; quota-exhausted-offline rejects edits (explicit read-only reason). Needs its own written plan.

## Summary of Changes

Verification pass over the wptk WIP (commit 485e967) surfaced and fixed five sync-engine defects (all TDD'd):

1. **opQueue**: durable batches left over from a previous page load never drained — `setOnline(true)` was a no-op on a fresh queue. First connect now always kicks the pump.
2. **opQueue**: persistence was serialized behind drain POSTs on one promise chain — one slow POST delayed durability of later edits, and a reload in that window lost them. Persist chain and single-flight drain pump are now decoupled.
3. **SyncProvider**: the offline gateway treated "connecting" as offline, shimming (or OfflineError-ing) fetches during the initial handshake. Only "reconnecting" (a genuinely dropped socket) is offline now; cold-start-offline is covered by apiFetch's fetch-failure fallback.
4. **SyncProvider**: a first connect with a non-empty durable queue now uses the reconnect ordering (flush -> pull -> resync bump) — the flushed batches echo back under this tab's own clientId, so only the bump can refresh views.
5. **replica**: authoritative writes (applySnapshot AND applyChanges) clobbered optimistically-applied pending state, reverting visible text and poisoning the next base_text_hash into spurious server conflict copies. Both now re-apply pending batches (per-batch savepoints). enqueueBatch also persists when optimistic apply cannot (un-hydrated blocks) instead of dropping the edit into a desync loop, and worker enqueue installs the schema on demand when an edit beats init().

Also: OfflineIndicator/apiFetch-gateway/localApi router+journal edge tests for coverage, e2e offline scenario (web/e2e/offline.spec.ts) driving edit/create/autocomplete/backlinks offline via routeWebSocket + setOffline with reconnect drain + server-state assertions.

Full verification: web 582 unit tests + coverage thresholds, pnpm typecheck, e2e suite 8/8 consecutive green, server pytest 376 + pyrefly + ruff.
