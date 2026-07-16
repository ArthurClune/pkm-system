# Task 1 Report: Worker lifecycle and queue completion contracts

## Status

Implemented and verified `pkm-dcmm`. The bean is completed and all acceptance
criteria are checked.

## Implementation

- Extended `PortLike` with worker terminal events and added `RpcLifecycleError`
  kinds for `worker-error`, `message-error`, `timeout`, and `disposed`.
- Added the `RpcClient.call(..., { timeoutMs })` and idempotent `dispose(reason)`
  contracts. Terminal failures reject and remove every pending entry, timers are
  cleared, late replies are ignored, and calls after termination reject with the
  original terminal cause.
- Applied 30-second ordinary RPC timeouts and 120-second snapshot/reset timeouts.
- Added idempotent `Replica.dispose()`. The `close` worker handler closes the
  active SQLite/OPFS database before the main-thread facade terminates the Worker.
- Added `WriteOutcome`, `WriteTicket`, `DrainOutcome`, and the exact `OpQueue`
  settlement/drain/pause/resume/dispose surface. Removed the ambiguous `idle()`
  surface.
- Decoupled persistence from delivery. Replica tickets settle only after durable
  `pending_ops` acceptance; legacy tickets settle after in-memory retention.
  Storage failures settle as failed. HTTP success/failure never changes a ticket
  after settlement.
- Retained work on network/5xx failure and added cancellable retries at 250 ms,
  1 second, then 5 seconds capped. Reconnect and successful delivery reset the
  schedule; offline, recovery pause, and disposal cancel scheduled work.
- Preserved existing replica 4xx poison handling and legacy 4xx desync behavior.
- Changed reconnect ordering to continue into replica feed pull/resync only for
  `{status: "drained"}`.
- Changed the outline-facing `Sync` contract to expose tickets and persistence
  settlement, not provider-internal delivery drain. `useOutline` scopes writes by
  page and tracks each ticket's settlement.
- SyncProvider now disposes its queue and only its internally created replica.
  Caller-injected replicas remain caller-owned. Async completions are guarded
  after unmount. Cleanup is deferred by one microtask so React StrictMode effect
  replay does not dispose memoized resources; a real unmount still closes and
  terminates exactly once.

### WriteOutcome clarification

The task brief referenced `WriteOutcome` without defining it. The parent clarified:

```ts
type WriteOutcome =
  | { status: "persisted"; pending: number }
  | { status: "failed"; error: unknown };
```

`persisted` means durable worker storage in replica mode and retained memory in
legacy mode. A later direct-post fallback does not retroactively claim durable
persistence after a replica storage failure.

## TDD evidence

### RPC/replica RED

Command:

```text
cd web && pnpm vitest run src/replica/rpc.test.ts src/replica/client.test.ts
```

Result: exit 1; 6 failed, 12 passed. Terminal-event and timeout tests timed out
because `PortLike`/`RpcClient` had no lifecycle support; disposal tests failed
with `rpc.dispose is not a function` and `replica.dispose is not a function`.

### Queue RED

Command:

```text
cd web && pnpm vitest run src/sync/opQueue.replica.test.ts src/sync/opQueue.test.ts
```

Result: exit 1; 6 failed, 18 passed. All new cases failed at
`Cannot read properties of undefined (reading 'settled')` because enqueue still
returned void and no typed drain contract existed.

### Provider RED

Command:

```text
cd web && pnpm vitest run src/sync/SyncProvider.test.tsx src/sync/connectionAware.test.tsx
```

Result: exit 1; 3 failed, 18 passed. Owned worker cleanup produced no close or
termination, blocked reconnect incorrectly bumped resync, and the migrated queue
initially exposed a reconnect integration failure.

### StrictMode self-review RED

Command:

```text
cd web && pnpm vitest run src/sync/SyncProvider.test.tsx
```

Result: exit 1; 2 failed, 17 passed. StrictMode effect replay prematurely closed
the internally owned worker and left the memoized queue disposed. This regression
test was added before the cleanup-timing fix.

## GREEN and verification evidence

- RPC/client focused: 2 files passed, 18 tests passed, exit 0.
- Queue focused: 2 files passed, 24 tests passed, exit 0.
- Provider/connection focused after migration: 2 files passed, 21 tests passed,
  exit 0.
- StrictMode provider regression after fix: 1 file passed, 19 tests passed,
  exit 0.
- Final task-focused command:

  ```text
  cd web && pnpm vitest run src/replica/rpc.test.ts src/replica/client.test.ts src/sync/opQueue.replica.test.ts src/sync/opQueue.test.ts src/sync/SyncProvider.test.tsx src/sync/connectionAware.test.tsx
  ```

  Result: 6 files passed, 64 tests passed, exit 0; fake timers drained and no
  unhandled rejections.

- `cd web && pnpm typecheck`: exit 0.
- `git diff --check`: exit 0.
- Canonical `cd web && pnpm verify`: exit 0. Typecheck passed; coverage run passed
  67 files / 671 tests; production Vite/PWA build passed; Playwright passed 6/6.
  The run emitted only pre-existing informational warnings (unmatched test route,
  expected SQLite constraint logging, Node localStorage experimental warning, and
  Vite chunk-size advisory).

## Files changed

- `.beans/pkm-dcmm--own-replica-worker-lifecycle-and-clarify-queue-idl.md`
- `web/src/replica/rpc.ts`
- `web/src/replica/rpc.test.ts`
- `web/src/replica/client.ts`
- `web/src/replica/client.test.ts`
- `web/src/replica/worker.ts`
- `web/src/replica/workerHandlers.ts`
- `web/src/sync/opQueue.ts`
- `web/src/sync/opQueue.replica.test.ts`
- `web/src/sync/opQueue.test.ts`
- `web/src/sync/SyncProvider.tsx`
- `web/src/sync/SyncProvider.test.tsx`
- `web/src/sync/replicaSync.test.ts`
- `web/src/outline/useOutline.ts`
- `web/src/outline/useOutline.dnd.test.tsx`
- `web/src/test-helpers.ts`
- `web/src/components/OfflineIndicator.test.tsx`
- `web/src/views/EditablePage.test.tsx`

No lockfile change was required.

## Self-review

- Re-read the task brief and checked every produced interface, ownership rule,
  timeout, retry value, cancellation rule, and reconnect ordering requirement.
- Verified pending-map entries and timers are removed on replies, terminal errors,
  timeouts, and disposal.
- Verified the database close acknowledgement precedes Worker termination and
  cleanup is idempotent.
- Verified replica persistence remains independent from slow or failed HTTP
  delivery and that a fresh replica pending count is zero after drain.
- Verified injected replicas are never disposed by SyncProvider.
- Found and fixed the StrictMode effect-replay lifecycle bug during review.
- Verified no ambiguous queue `idle()` API remains in the produced surface.

## Concerns

No blocking concerns. Retry scheduling is intentionally in-memory and restarts at
250 ms after a page reload; durable replica batches themselves remain intact and
are drained on the next connection.

## Review Fix Pass

### Findings addressed

- Added a safe drain-outcome observer at queue construction. SyncProvider tracks
  whether reconnect completion is pending and uses a single-flight completion
  promise, so an automatic retry that later drains performs feed pull and resync
  exactly once. Unrelated drained outcomes do not trigger reconnect work.
- Converted `nextBatch`, `deleteBatch`, and `markPoisoned` worker/RPC failures to
  typed blocked outcomes. A top-level drain catch plus isolated outcome/listener
  callbacks ensures public drains fulfill and automatic kicks do not create
  unhandled rejections.
- Added deterministic coverage for 250 ms, 1 second, and capped 5 second retry
  delays, success reset, and reconnect reset. The scheduling implementation
  already satisfied these exact values; the missing part was coverage.
- Reclassified delivery failures against the current offline/recovering/disposed
  state after the failed attempt (and after replica pending-count observation),
  before scheduling or returning retryable.

### Review RED evidence

`cd web && pnpm vitest run src/sync/opQueue.replica.test.ts`

- Exit 1: 6 failed, 13 passed, plus one unhandled rejection.
- `deleteBatch` and `markPoisoned` rejected `drain()` instead of fulfilling.
- The automatic delete failure produced no observed outcome and was reported by
  Vitest as an unhandled rejection.
- Offline, recovering, and disposed in-flight failure cases all incorrectly
  returned `reason: "retryable"`.
- The new full backoff/cap and success-reset test passed against the existing
  scheduler, confirming this review item was a test-coverage gap.

`cd web && pnpm vitest run src/sync/opQueue.test.ts`

- Exit 1: 3 failed, 14 passed.
- All legacy in-flight lifecycle transitions incorrectly returned retryable.
- The new reconnect-reset test passed against the existing scheduler.

`cd web && pnpm vitest run src/sync/SyncProvider.test.tsx`

- Exit 1: 1 failed, 19 passed.
- After the 250 ms automatic retry drained the durable batch, feed pull count and
  resync remained unchanged, proving reconnect recovery had no continuation.

### Review GREEN evidence

- Replica queue: 19/19 passed, no unhandled errors.
- Legacy queue: 17/17 passed.
- SyncProvider: 20/20 passed.
- Combined required command passed 3 files / 56 tests.
- `cd web && pnpm typecheck` passed.

### Canonical verification investigation

The first review-pass `pnpm verify` run passed typecheck, 67 files / 684 unit
tests, coverage, and the production build, then had one Playwright failure in
`offline-shell.spec.ts`: after reload, its expected newly typed `shell smoke`
text was absent from the offline replica. The isolated reproduction command
`pnpm playwright test e2e/offline-shell.spec.ts` immediately passed 1/1 against a
fresh scratch server, identifying a transient E2E persistence timing failure
rather than a deterministic queue review regression. A fresh full canonical run
is recorded below after final source/report review.

### Review self-review

- Verified every drain path fulfills `Promise<DrainOutcome>`, including fallback
  handling if an unexpected shell exception escapes `runDrain`.
- Verified failure classification re-reads lifecycle state after replica pending
  count resolves, so an offline/pause/dispose transition during the failed HTTP
  attempt takes precedence over retry scheduling.
- Verified outcome and pending/poison/quota listeners are isolated from the drain
  state machine.
- Verified reconnect completion is armed only by reconnect flow, single-flight,
  cleared before feed pull, and guarded after unmount.
- Verified automatic retries retain the exact 250 ms, 1 second, then capped 5
  second schedule, with both success and reconnect resetting to 250 ms.

### Final review verification

- `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts src/sync/opQueue.test.ts src/sync/SyncProvider.test.tsx`: 3 files / 56 tests passed, exit 0.
- `cd web && pnpm typecheck`: passed, exit 0.
- Fresh `cd web && pnpm verify`: passed, exit 0. Typecheck passed; coverage
  passed 67 files / 684 tests; production Vite/PWA build passed; Playwright
  passed 6/6, including the previously transient offline-shell case.
- `git diff --check`: passed, exit 0.

Review-fix files changed:

- `.beans/pkm-dcmm--own-replica-worker-lifecycle-and-clarify-queue-idl.md`
- `web/src/sync/opQueue.ts`
- `web/src/sync/opQueue.replica.test.ts`
- `web/src/sync/opQueue.test.ts`
- `web/src/sync/SyncProvider.tsx`
- `web/src/sync/SyncProvider.test.tsx`

## Second Review Fix Pass: Overlapping Reconnects

### Finding addressed

`finishReconnect` previously returned an existing `finishRun` before consuming
a newly armed `reconnectPending` flag. If a second reconnect completed its queue
drain while the first reconnect's feed pull was still running, that second
intent stayed armed. A later unrelated successful queue drain then performed an
extra feed pull and resync.

The completion helper now checks mount state, consumes a pending reconnect
intent, and only then reuses an existing completion promise. Calls without a
pending intent may still await the active completion, preserving single-flight
behavior without leaving stale work armed.

### Deterministic RED evidence

Added `overlapping reconnects share one completion and leave no stale intent`,
which holds the first reconnect feed request, opens a second reconnect, releases
the shared completion, then drains an unrelated delete operation.

`cd web && pnpm vitest run src/sync/SyncProvider.test.tsx`

- Exit 1: 1 failed, 20 passed.
- The unrelated later drain increased the changes-feed call count from the
  expected 3 to 4, demonstrating that the second reconnect had left stale
  intent armed.

### GREEN evidence

- Focused SyncProvider suite: 21/21 passed.
- Combined provider and queue suites: 3 files / 57 tests passed.
- `cd web && pnpm typecheck`: passed, exit 0.

### Second-pass self-review

- Verified the newly pending intent is cleared before an active `finishRun` is
  returned.
- Verified both overlapping reconnect callers share the first feed pull and
  resync completion.
- Verified an unrelated later drained outcome performs no additional feed pull
  or resync.
- Retained the existing automatic retry completion test alongside the overlap
  regression test.

### Second-pass final verification

- `cd web && pnpm vitest run src/sync/SyncProvider.test.tsx src/sync/opQueue.replica.test.ts src/sync/opQueue.test.ts`: 3 files / 57 tests passed, exit 0.
- `cd web && pnpm typecheck`: passed, exit 0.
- Two fresh `cd web && pnpm verify` runs each passed typecheck, coverage
  (67 files / 685 tests), and the production Vite/PWA build. Each reached 5/6
  Playwright tests before the pre-existing suite-order persistence timing case
  in `offline-shell.spec.ts` failed: after reload, the replica showed valid
  prior shared-server journal content but not the newly typed `shell smoke`.
- `cd web && pnpm playwright test e2e/offline-shell.spec.ts`: passed 1/1
  immediately against a clean scratch server. The overlap fix does not touch
  replica persistence or E2E code; no unrelated E2E change was made.
- `git diff --check`: passed, exit 0.

Second-review files changed:

- `.beans/pkm-dcmm--own-replica-worker-lifecycle-and-clarify-queue-idl.md`
- `web/src/sync/SyncProvider.tsx`
- `web/src/sync/SyncProvider.test.tsx`

## Offline-shell race root-cause fix

### Phase 1 causal trace

Temporary diagnostics recorded browser request/response bodies and worker
transaction boundaries in one sequence. A fresh full `pnpm e2e` invocation
passed 6/6 and showed the good ordering: the changes response contained the
`shell smoke` row. The next fresh full invocation failed 5/6 and conclusively
captured the bad ordering:

1. The create batch returned HTTP 200 at `1784131056112`.
2. `GET /api/sync/changes?since=19` dispatched at `1784131056114`.
3. The `shell smoke` update POST dispatched at `1784131056115` and returned
   HTTP 200 at `1784131056119`.
4. The exact changes response had `latest_seq: 23` and the new block UID
   `FrN9pcTTLbeAxpU_` with `text: ""`; it did not contain `shell smoke`.
5. The worker committed `deleteBatch(2)` with `pending: 0` at
   `1784131056120`, while its local block still contained `shell smoke`.
6. The worker then began applying that stale feed with `pending: 0` and no
   shell-smoke feed block. Reload followed at `1784131056125`.
7. The replacement worker's first offline journal read had `pending: 0` and no
   shell-smoke block, and the visible assertion failed.

Root cause: a changes request can be dispatched while an optimistic batch is
pending, then return after the batch's POST is acknowledged and its durable row
is deleted. Applying that older response after deletion leaves no pending batch
for `reapplyPending`, so the stale authoritative row overwrites the acknowledged
local edit. Waiting for the POST response is insufficient because it is the
relative feed-request lifetime and pending-set transition that matter.

### Deterministic RED

Added a MessageChannel + real SQLite regression that snapshots pending batch
IDs at feed dispatch, deletes the acknowledged batch, and then applies the stale
feed. Added a replica-sync regression requiring an invalidated response to be
refetched from the same cursor.

Command:

```text
cd web && pnpm vitest run src/replica/client.test.ts src/sync/replicaSync.test.ts
```

Result: exit 1; 2 failed, 21 passed. The real-worker regression returned
`{status: "applied", cursor: 6}` instead of `pending-changed` and overwrote the
local text. Replica sync fetched once instead of twice.

### Minimal fix and GREEN

Replica sync now snapshots ordered pending batch IDs immediately before each
changes request. The worker receives the response with that snapshot and,
before entering the synchronous apply transaction, atomically compares it with
the current durable pending IDs. A mismatch returns `pending-changed` without
touching rows or cursor; replica sync refetches from the same cursor. Worker
message ordering closes the check/apply gap: prior enqueue/delete messages are
observed by the guard, while later optimistic writes apply after the feed and
remain visible. Persistence settlement and HTTP delivery remain decoupled.

The same focused command then passed 2 files / 23 tests. The broader affected
command passed 5 files / 79 tests, and `pnpm typecheck` passed. All temporary
`SHELL_DEBUG` instrumentation, the disproven POST-response wait, and the false
`.ws-banner` settlement assertion were removed.

### Fresh final verification

- Three separate `cd web && pnpm e2e` invocations passed 6/6, 6/6, and 6/6.
  No `--repeat-each` was used; every invocation had a fresh scratch server/DB.
- Fresh `cd web && pnpm verify` passed: typecheck; coverage 67 files / 687
  tests; production Vite/PWA build; Playwright 6/6.
- `git diff --check` passed before tracker/report completion and was rerun after
  final edits.

### Final self-review

- Verified stale responses do not advance the cursor or mutate replica rows.
- Verified valid responses still apply when the pending ID set is unchanged.
- Verified a rejected stale response refetches from the original cursor.
- Verified the guard compares ordered durable IDs inside the worker immediately
  before synchronous feed application, avoiding a main-thread TOCTOU gap.
- Verified no diagnostics, arbitrary delays, or response waits remain.

## FCIS classification review fix

Task re-review identified that `web/src/replica/rpc.ts` declared itself a
Functional Core despite assigning MessagePort/Worker event handlers, owning the
mutable pending-call map and timers, posting messages, and disposing terminal
lifecycle resources. The header now classifies the runtime module as an
Imperative Shell and describes those responsibilities. No runtime behavior was
changed. The review's separate test-output-noise observation was Minor and was
intentionally left outside this focused fix.

Fresh verification:

- `cd web && pnpm vitest run src/replica/rpc.test.ts src/replica/client.test.ts`:
  2 files / 19 tests passed, exit 0.
- `cd web && pnpm typecheck`: passed, exit 0.
- `git diff --check`: passed, exit 0 before and after the tracker/report update.
