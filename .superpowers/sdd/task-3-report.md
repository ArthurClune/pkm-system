# Task 3 report: authoritative repair after rejected batches

Bean: `pkm-huv4`

Base: `2abd159`

## Implementation

- Added the exact typed `PoisonEvent` surface with durable row id, batch id,
  wire operations, HTTP status, and normalized error message.
- Changed replica queue 4xx handling to preserve event details, durably mark the
  row poisoned, update pending observers, establish the recovery pause, and only
  then emit. The drain returns `blocked/recovering`; no later row posts.
- Persisted typed status/message data in the existing `pending_ops.error`
  column. Added a separate oldest-first poison query and worker/client RPC for
  startup discovery. This deliberately does not change Task 2's
  migration-stable `allBatches` recovery read or its complete private-row
  fingerprint.
- Extended the shared Task 2 coordinator with
  `rebaseAuthoritative("poison")`. Poison repair waits for any already-dispatched
  pending-id-guarded feed, holds the existing deadline-bound worker lease,
  skips all pre-snapshot POST flushing, applies a full authoritative snapshot,
  and returns with delivery still paused.
- SyncProvider subscribes to runtime poison events and pauses delivery while
  discovering durable poison at startup. Startup poison is repaired before
  normal replica initialization/schema recovery, closing the reload window in
  which a later batch could otherwise post first.
- Successful repair deletes every repaired poison row, retains the first event
  for UI details, bumps `resyncSeq`, and only then resumes delivery. Snapshot
  and feed application continue to reapply only non-poisoned batches; after
  deletion, a rejected operation cannot be reapplied by any later snapshot or
  feed.
- Failed repair aborts the lease, retains poison rows and details, leaves normal
  delivery paused, and surfaces a connected `rejected-batch/failed` problem.
  Retry reruns the same guarded full-snapshot path. Dismiss is a no-op until the
  repair is successful and never posts, retries, or reapplies the rejected ops.
- OfflineIndicator now renders delivery health independently of websocket
  connectivity. Running, failed, and repaired states show HTTP/batch/op details;
  failed exposes Retry, while repaired exposes Dismiss.

## Durable poison and user recovery policy

The durable poison row is the recovery source of truth until a full snapshot
has committed successfully. A failed or interrupted repair keeps the row and
the queue pause across reconnects; reload discovers it and retries repair before
later delivery. Rows written by the previous implementation are supported by
parsing their stored `ApiError: request failed: <status>` string. New rows store
JSON status/message metadata in the existing `error` column.

Connected editing remains allowed. Persistence stays separate from HTTP
delivery: writes arriving during a held lease wait behind the worker gate and
persist after commit/abort, while later POST delivery remains stopped. After a
successful repair, poison rows are deleted rather than retained as a retryable
audit entry. Event details remain only in provider/UI state until the user
dismisses them.

## TDD evidence

### Structured poison and ordering RED

Command:

```text
cd web && pnpm vitest run src/sync/opQueue.replica.test.ts src/sync/SyncProvider.test.tsx
```

Result: exit 1; 2 intended failures, 39 passes. The queue regression received a
raw `ApiError` instead of the structured event, and the provider regression
observed that no snapshot repair started. The command was rerun after removing
an initial test wait that contaminated later cleanup; the final RED was isolated
and deterministic.

### Replica rollback/startup metadata RED

Command:

```text
cd web && pnpm vitest run src/replica/apply.test.ts src/replica/queue.test.ts
```

Result: exit 1; 1 intended failure, 24 passes. The full text+move rejection,
independent valid batch, repair deletion, later same-block valid edit, feed, and
second snapshot invariant already passed through the existing skip-poison apply
core. The missing durable poison-enumeration boundary failed explicitly.

### Startup repair RED/GREEN

Focused provider RED: exit 1; 1 intended failure, 22 passes. A durable poisoned
row plus later valid row did not start a snapshot, proving startup did not
discover poison. After implementation, the provider suite passed 23/23 and
proved the later row did not POST until repair completed.

### Recoverable UI RED/GREEN

Focused provider/UI RED: exit 1; 4 intended failures, 30 passes. Retry/Dismiss
controls were absent and connected problem banners did not exist. GREEN passed
34/34 and proved failed repair stays visible and connected, failed Dismiss is a
no-op, Retry succeeds, repaired Dismiss clears only UI state, and the rejected
batch POST count remains exactly one.

### Stale-feed self-review RED/GREEN

Self-review identified a feed already past the Task 1 pending-id guard that
could finish after the poison snapshot. The new coordinator regression failed
with `snapshotCalls` 1 instead of 0 while the feed was held (17 other tests
passed). After making poison rebase wait under the queue pause, the queue,
provider, and coordinator group passed 61/61.

## Verification

- Exact Task 3 Step 5 command: 5 files / 78 tests passed.
- Exact Task 2 compatibility command: 6 files / 84 tests passed, including
  recovery deadline/expiry, complete durable fingerprint, transactional schema
  reset, queue pause/resume, and provider integration coverage.
- `cd web && pnpm typecheck`: passed.
- Canonical `cd web && pnpm verify`: passed.
  - TypeScript passed.
  - Coverage passed: 69 files / 713 tests; 98.2% statements, 92.03% branches,
    95.64% functions, and 98.2% lines.
  - Production/PWA build passed: 78 precache entries / 5117.81 KiB.
  - Playwright passed 6/6, including offline-shell and offline reconnect.
- `git diff --check`: run again after report/bean updates before commit.

## Files changed

Production/runtime:

- `web/src/sync/opQueue.ts`
- `web/src/sync/replicaSync.ts`
- `web/src/sync/SyncProvider.tsx`
- `web/src/components/OfflineIndicator.tsx`
- `web/src/replica/client.ts`
- `web/src/replica/queue.ts`
- `web/src/replica/apply.ts` (repair/non-reapply contract comment)
- `web/src/replica/workerHandlers.ts`

Tests/support:

- `web/src/sync/opQueue.replica.test.ts`
- `web/src/sync/replicaSync.test.ts`
- `web/src/sync/SyncProvider.test.tsx`
- `web/src/components/OfflineIndicator.test.tsx`
- `web/src/replica/apply.test.ts`
- `web/src/replica/queue.test.ts`
- `web/src/replica/client.test.ts`
- `web/src/test-helpers.ts`

Tracking/report:

- `.beans/pkm-huv4--reconcile-optimistic-state-after-server-rejected-b.md`
- `.superpowers/sdd/task-3-report.md`

## Self-review and concerns

- Re-read the Task 3 brief, approved design/plan, and `pkm-huv4`
  reconnaissance against the final production diff.
- Verified the 4xx order is POST -> durable mark -> pause -> typed emit, and the
  repair order is wait for guarded feed -> lease -> snapshot/commit -> poison
  delete -> resync bump -> resume.
- Verified poison recovery never calls the coordinator's normal pending-batch
  flush, so later valid rows cannot POST before repair.
- Verified Task 2 worker code still fingerprints the complete durable row
  (`id`, `batch_id`, `ops_json`, `poisoned`, and private `error`), uses the same
  lease deadline/expiry timer, and performs schema-wide reset transactionally.
- Verified Task 1's persistence/delivery split and pending-id stale-feed guard
  remain intact; the new pre-rebase wait closes the remaining in-flight window.
- Verified all edited runtime modules retain accurate Imperative Shell FCIS
  classifications; `apply.ts` remains an Imperative Shell because it owns
  transactional SQLite application.
- No unresolved correctness concern remains. The focused SQLite tests continue
  to print their pre-existing, expected savepoint foreign-key diagnostic, and
  the production build continues to print its existing large-chunk warning;
  both canonical gates pass.

## Independent review fix: nested recovery ownership

The independent Task 3 review identified an Important race in the initial
in-flight-feed guard. Poison repair paused the queue and waited for the active
pull, but a held feed could return `needs-bootstrap` during that wait. Its
normal Task 2 recovery then owned no poison context: it flushed later
non-poisoned batches and called `resume("recovery")` against the queue's boolean
pause before poison's authoritative snapshot had run. A failed poison snapshot
left the same path open before Retry.

### Review RED

Command:

```text
cd web && pnpm vitest run src/sync/replicaSync.test.ts
```

Result: exit 1; 1 intended failure, 18 passes. The deterministic test held an
in-flight changes request, started poison repair, returned `needs-bootstrap`,
failed the first poison snapshot, triggered another bootstrap-needing feed, and
held Retry's snapshot. The current coordinator POSTed `later-valid` twice and
resumed normal recovery before Retry, rather than keeping both counts at zero.

### Ownership design and GREEN

`replicaSync` now records authoritative poison ownership before awaiting any
in-flight pull. While that owner exists, a feed `needs-bootstrap` result exits
the pull instead of entering normal Task 2 recovery, so it cannot flush later
rows or balance the queue's boolean pause prematurely. Ownership deliberately
survives snapshot failure and Retry. The provider releases it explicitly only
after the full snapshot commits, every repaired poison row is deleted, and the
resync state update is scheduled; provider queue resume remains the final
action. Existing schema/generation recovery is unchanged when no poison owner
exists.

Fresh review-fix verification:

- Focused queue/provider/coordinator: 3 files / 62 tests passed.
- Exact Task 3 Step 5: 5 files / 78 tests passed.
- Exact Task 2 compatibility: 6 files / 85 tests passed.
- `cd web && pnpm typecheck`: passed.
- Canonical `cd web && pnpm verify`: passed; 69 unit files / 714 tests,
  production/PWA build with 78 entries / 5117.94 KiB, and Playwright 6/6.
