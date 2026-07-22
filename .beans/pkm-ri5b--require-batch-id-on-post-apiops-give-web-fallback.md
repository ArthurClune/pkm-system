---
# pkm-ri5b
title: Require batch_id on POST /api/ops; give web fallback paths real batch ids
status: done
type: bug
priority: high
created_at: 2026-07-22T10:12:47Z
updated_at: 2026-07-22T11:37:00Z
---

Fix B of docs/superpowers/specs/2026-07-22-sync-hardening-design.md (incident bean pkm-8uld). Id-less batches apply unconditionally on every retry/replay, which re-applied stale edits during the incident. Server: OpBatch.batch_id required, 422 when absent, openapi+types regen. Web: legacy queue freezes slice+id across retries; quota fallback mints an id.

## Summary of Changes

### Server half (Task 1, commits `8a5f2a9`, `e4baf05`)

- `server/src/pkm/server/ops_core.py` / `routes_ops.py`: `OpBatch.batch_id` is
  now a required field; POST `/api/ops` rejects a batch with no `batch_id`
  with 422 instead of silently minting one and applying it.
- `server/src/pkm/client/api.py`: `post_ops` keeps `batch_id` explicit rather
  than silently minting one client-side if the caller omits it — the caller
  is responsible for supplying a stable id when a retry needs to reuse it.
- `web/src/api/openapi.json` + `web/src/api/types.d.ts` regenerated to match.
- Server test suite updated across `test_ops_endpoint.py`,
  `test_ops_idempotency.py`, `test_ops_apply.py`, `test_ops_core.py`,
  `test_sync_endpoints.py`, `test_preflight.py`, `test_todos_endpoint.py`,
  `test_ws.py`, `test_db_concurrency.py`, `test_client_api.py` to cover the
  422 path and explicit-id behavior.

### Web half (Task 2, commit `6a79648`)

- `web/src/sync/opQueue.ts`:
  - `createLegacyQueue`'s `runDrain` now freezes `{ id, ops }` for a batch on
    its first POST attempt (module-level `frozen`, not scoped inside
    `runDrain`, since a 5xx failure returns out of that function and the
    retry timer calls a fresh `runDrain()` — the freeze must survive that
    boundary). A retry reuses the same `newUid()` id and the exact same ops
    slice, so the resend is byte-identical to what the server hashed for
    `batch_id` on the first attempt. Ops enqueued while a batch is in flight
    or backing off no longer silently join that batch; they wait for the
    next one. `frozen` is released (`null`) on success and on a terminal
    4xx (those ops are being discarded from `pending` anyway).
  - `createReplicaQueue`'s storage-quota fallback (`persist`'s catch branch)
    now calls `postOps(ops, newUid())` instead of `postOps(ops)`, so even
    the best-effort direct POST used when the sqlite replica can't accept a
    write carries a `batch_id`.
- Tests: `web/src/sync/opQueue.test.ts` gained
  "legacy queue sends a batch_id and freezes the slice across retries"
  (500 → retry-with-frozen-payload → 200, plus a third batch for an op
  enqueued mid-backoff) and had the coalescing test and the missed-in-flight-
  kick 5xx backoff test updated for batch-id-tolerant/frozen-slice
  assertions (the latter's op count moved from 2 to 3 POSTs, since the op
  enqueued during the first in-flight attempt no longer merges into the
  retry). `web/src/sync/opQueue.replica.test.ts`'s quota-fallback test now
  asserts a `batch_id` is present instead of asserting its exact absence.

Verification: `pnpm vitest run src/sync/opQueue.test.ts src/sync/opQueue.replica.test.ts` (54/54 passed), `pnpm test:unit` (1285/1285 passed across 95 files), `pnpm typecheck` (clean), `pnpm test:coverage` (passed, thresholds intact).
