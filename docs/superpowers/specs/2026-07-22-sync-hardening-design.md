# Sync hardening — surface wedged replicas, dedupe every op batch, stop resurrecting daily pages

Date: 2026-07-22. Origin: incident investigation in bean pkm-8uld (daily notes
"vanished"; three clients simultaneously wedged). Three independent fixes,
one theme: a degraded client must fail loudly and recover cleanly instead of
silently corrupting or confusing state.

## Fix A — wedged replica sync must surface and offer recovery (web)

### Problem

`replicaSync.pullLoop` failures are swallowed (`pull().catch(() => undefined)`),
and a failed `recover()` returns `false` with no retry schedule. A replica that
persistently cannot apply the feed (storage quota during the ~15 MB snapshot
re-bootstrap was the likely incident trigger) freezes its cursor forever while
the app looks healthy apart from the offline banner. The Mac sat at feed seq
3911 for ~2 days. Additionally the `pending-changed → continue` path can retry
without progress indefinitely.

### Design

1. **Stall detection** in `createReplicaSync`: count consecutive pull attempts
   that end in an error or make no cursor progress (including `pending-changed`
   retries within one `pullLoop` call, capped at 20 iterations per call).
   After 3 consecutive failed/no-progress pull attempts, report a new state
   `{ mode: "stalled", error }` via `onState`. Any successful cursor advance
   resets the counter and reports `{ mode: "ready" }` again.
2. **Retry with backoff**: a stalled replica schedules its own retry pulls
   (1s doubling to 60s cap) instead of waiting for the next WS nudge, so
   recovery after a transient failure does not depend on server activity.
3. **Surfacing**: `SyncProvider` maps `stalled` and `recovery-failed` (when
   connected) to a new `SyncProblem` kind `"replica-stalled"` rendered by the
   existing problem-banner path — visually distinct from the offline banner —
   with the error text and a **Reset local data** action.
4. **Reset action**: reuses the existing recovery machinery
   (`runRecovery("reset", { flush: true, … })`): pause queue → flush pending
   batches (batch_id dedup makes replay safe) → `replica.reset()` +
   snapshot bootstrap → resume + resync bump. If the flush fails, show a
   confirm step: "N unsent edits could not be delivered and will be
   discarded" before resetting. Success clears the problem banner.

### Testing

Unit tests in `replicaSync.test.ts` (stall detection, backoff scheduling,
counter reset on progress, iteration cap) and `syncState.test.ts` (problem
transitions); `SyncProvider.test.tsx` for banner rendering and the reset
action happy path + failed-flush confirm path.

## Fix B — every op batch carries a batch_id; server rejects those that don't

### Problem

`POST /api/ops` applies batches without a `batch_id` unconditionally
("pre-offline client" compatibility). Two current-code paths still send
id-less batches — the legacy in-memory queue (no-replica mode) and the
storage-quota fallback — and stale service-worker bundles do so by design.
Any retry or replay re-applies, which re-scrambled block order and reverted
edits during the incident.

### Design

1. **Server**: `OpBatch.batch_id` becomes required (422 when absent).
   `openapi.json` and `types.d.ts` regenerated and committed with the change.
   Stale bundles now fail loudly (existing client 4xx handling puts them in
   the visible rejected-batch repair flow) instead of corrupting silently.
2. **Web legacy queue** (`createLegacyQueue`): when a batch slice is first
   attempted, mint a `batch_id` AND freeze that exact ops array; retries
   resend the identical frozen payload under the same id (the server binds a
   batch_id to its request hash, so a grown slice would be rejected). Ops
   enqueued during retries join the next slice. Clear the frozen batch when
   it succeeds or is rejected. Retries after 5xx therefore dedupe
   server-side.
3. **Web quota fallback** (`createReplicaQueue` enqueue catch): mint a
   `batch_id` for the direct `postOps` call.

### Testing

Server: `test_ops` cases — missing batch_id → 422; present → applied once,
replay returns cached response. Web: legacy queue reuses the id across a 5xx
retry; quota fallback request carries an id.

## Fix C — GET must not resurrect daily pages (server + web + replica)

### Problem

`GET /api/page/<title>` auto-creates any page whose title parses as a daily
note. Reads create rows: the investigation's own CLI reads created three
empty daily pages (which then rendered as phantom empty days in the journal
until cleanup deleted them — the "iPad resets the page" observation), and
deleted dailies came back as zombies (July 11th was deleted three times).

### Design

1. **Server** (`get_page`): auto-create only when the title is exactly
   *today's* daily title (preserves "today always exists" ergonomics for the
   CLI and direct navigation); any other missing daily 404s like a normal
   page. `get_journal`'s today-only creation is already correct; cleanup
   unaffected.
2. **Web `PageView`**: on a 404 whose title parses as a daily date, render an
   empty editable page from a fabricated empty payload instead of the error
   paragraph. The page row is created lazily by the first edit (`CreateOp`
   resolves its page via get_or_create). Non-daily 404s keep the current
   error rendering.
3. **Journal authoritative loaders**: the per-day session loader treats a 404
   as an empty block list (the day was deleted underneath the view) rather
   than a failed load.
4. **Replica localApi** (`pages.ts`): mirror the server — local auto-create
   only for today's title; other missing dailies return the local 404
   equivalent. `localApi/journal.ts` already creates only today.

### Testing

Server: past daily GET → 404 and no row created; today GET → created.
Web: PageView renders empty editable page for missing past daily, error for
missing normal page; journal day loader maps 404 → empty. Replica localApi
parity tests mirror the server cases.

## Out of scope

- The daily "carry forward" workflow itself (Arthur's drag of the Todos root)
  and any drag-and-drop changes on the journal — deferred pending
  clarification of what "fix DnD on the daily page properly" should mean
  (draft bean).
- Service-worker update strategy for stale bundles (fix B makes stale
  bundles fail loudly, which is the safety property; forcing updates is a
  separate concern).
