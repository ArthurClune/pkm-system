# Task 2 Report: Atomic replica recovery gate

## Status

Implemented and verified `pkm-qvqz`. The worker now owns a FIFO recovery gate,
and schema mismatch plus feed rebootstrap share one queue-aware coordinator.

## Implementation

- Added `RecoveryLease`, `RecoveryCommit`, and the three Replica recovery RPCs.
- Added a worker-owned FIFO gate. Every handler that touches the database runs
  through it, including `Replica.enqueue`, queue row mutation/read handlers,
  snapshots/feeds, and offline `localApi` POST/GET calls.
- `prepareRecovery` waits for earlier database work, captures the complete
  oldest-first durable row set, fingerprints it, and holds one active token.
  Later database calls cannot acknowledge or touch the old database until the
  lease commits or aborts.
- `commitRecovery` validates the active token and compares the complete durable
  rows immediately before authoritative work. A mismatch refuses reset/rebase.
  Schema reset transactionally drops/reinstalls known schema objects and applies
  the snapshot on the active OPFS connection, so any DDL/snapshot exception
  rolls back to the complete old database. Feed rebase applies the snapshot in
  place and preserves/reapplies stable pending and poisoned rows.
- Commit success, commit failure, prepare failure, and abort release exactly one
  FIFO slot. Invalid and reused commit/abort tokens reject.
- Kept the legacy direct `reset()` compatibility RPC, but serialized it and made
  the worker refuse it when durable rows exist.
- Replaced the two recovery paths in `replicaSync` with one coordinator. It
  pauses Task 1 queue delivery, prepares the lease, POSTs non-poisoned lease
  batches oldest-first using their durable `batch_id`, fetches the snapshot,
  commits reset+snapshot, and resumes delivery in `finally`.
- Flush, snapshot, and commit failures report `recovery-failed`, attempt abort
  when a token was acquired, retain pre-commit durable state, and resume/kick the
  queue. A commit that already released rejects the defensive abort as a reused
  token; that secondary error is intentionally ignored.
- Passed the Task 1 queue from `SyncProvider` without joining queue persistence
  to HTTP delivery. Writes accepted during recovery remain pending behind the
  worker gate and persist into the fresh database after release.
- Applied the long 120-second RPC timeout to prepare and commit, matching
  snapshot/reset operations that may wait on or rebuild the database.

## Acknowledgment boundary and trace

The guarantee begins when the worker RPC for `enqueue` or mutating `localApi`
successfully resolves. Work that reaches the worker before `prepareRecovery` is
included in its stable lease rows and flushed. Work arriving after prepare is
FIFO-blocked and cannot resolve until commit/abort; after a successful reset it
persists into the fresh database. There is no outcome in which a successful
worker enqueue response is neither flushed nor retained.

Both schema mismatch and feed `needs-bootstrap` now execute:

```text
pause queue
prepare lease
flush non-poisoned batches oldest-first
fetch snapshot
compare final durable rows
reset-or-rebase plus snapshot
release lease
resume queue
```

## TDD evidence

### Enqueue/reset and token RED

Command:

```text
cd web && pnpm vitest run src/replica/client.test.ts src/replica/workerHandlers.test.ts
```

Result: exit 1; 3 failed, 11 passed. The MessageChannel regression and both
worker token/final-row cases failed with `prepareRecovery is not a function`.
The client regression used deferred dispatch barriers, not timers, and checked
that both `Replica.enqueue` and `POST /api/pages` were dispatched yet neither
acknowledged nor mutated the old SQLite database.

### Recovery-gate primitive RED

Command:

```text
cd web && pnpm vitest run src/replica/recoveryGate.test.ts
```

Result: exit 1 before collection because `./recoveryGate` did not exist. After
the primitive was added, its FIFO/abort assertion initially exposed an invalid
one-microtask test assumption; that assertion was changed to await an explicit
deferred `earlierStarted` barrier. The deterministic suite then passed 3/3.

### Shared coordinator RED

Command:

```text
cd web && pnpm vitest run src/sync/replicaSync.test.ts
```

After correcting one mock that returned a snapshot for a changes request (which
caused a fixture-only infinite pull), the real RED was exit 1; 3 failed,
12 passed. Received traces lacked queue pause/resume, prepare/commit/release, and
abort because both paths still used independent pending reads plus `reset()`.

### Self-review timeout RED

Command:

```text
cd web && pnpm vitest run src/replica/client.test.ts -t "snapshot and recovery RPCs"
```

Result: exit 1; the new prepare call settled at the ordinary 30-second timeout.
After assigning the long timeout, the same focused case passed 1/1.

## GREEN and verification evidence

- Gate/client/worker focused: 3 files / 19 tests passed.
- Shared coordinator focused after compatibility assertion migration:
  1 file / 17 tests passed.
- Exact Task 2 focused/compatibility command:

  ```text
  cd web && pnpm vitest run src/replica/recoveryGate.test.ts src/replica/client.test.ts src/replica/workerHandlers.test.ts src/sync/replicaSync.test.ts src/sync/opQueue.replica.test.ts src/sync/SyncProvider.test.tsx
  ```

  Result: exit 0; 6 files / 76 tests passed.

- `cd web && pnpm typecheck`: exit 0.
- `git diff --check`: exit 0.
- Canonical `cd web && pnpm verify`: exit 0. Typecheck passed; coverage passed
  69 files / 700 tests; production Vite/PWA build passed; Playwright passed 6/6.
  Output contained only the repository's pre-existing informational warnings:
  unmatched test route, expected SQLite constraint log, Node localStorage
  experimental warning, and Vite chunk-size advisory.

## Files changed

- `.beans/pkm-qvqz--make-replica-recovery-atomic-with-concurrent-enque.md`
- `.superpowers/sdd/task-2-report.md`
- `web/src/replica/recoveryGate.ts`
- `web/src/replica/recoveryGate.test.ts`
- `web/src/replica/client.ts`
- `web/src/replica/client.test.ts`
- `web/src/replica/workerHandlers.ts`
- `web/src/replica/workerHandlers.test.ts`
- `web/src/replica/worker.ts`
- `web/src/sync/replicaSync.ts`
- `web/src/sync/replicaSync.test.ts`
- `web/src/sync/SyncProvider.tsx`
- `web/src/sync/SyncProvider.test.tsx`
- `web/src/sync/opQueue.replica.test.ts`

No lockfile change was required. The unrelated untracked execution handoff was
preserved and is not part of this task.

## Self-review

- Re-read the Task 2 brief and architecture reconnaissance line by line.
- Verified all database-touching worker handlers share the gate, so reads never
  access a closed database and both mutation entry points are covered.
- Verified prepare is FIFO behind earlier work, later work remains ordered, and
  valid commit/abort invalidates the token before asynchronous release work.
- Verified the final comparison includes ids, durable batch ids, op payloads,
  poison state, and ordering, and happens inside the held gate before reset.
- Verified schema mismatch ignores the stale init row snapshot and re-reads rows
  through `prepareRecovery`; feed rebootstrap uses the identical coordinator.
- Verified every coordinator path resumes the Task 1 queue in `finally`, and
  queue pause does not merge durable persistence with network delivery.
- Verified poisoned rows are retained in the fingerprint but skipped for POST,
  preserving existing recovery behavior.
- Verified runtime FCIS classifications remain accurate: the gate, worker
  handlers, client facade, sync coordinator, and provider are Imperative Shells.
- Found and fixed the prepare timeout mismatch during self-review.

## Review fix pass

The read-only review found two valid issues before commit:

- **Critical:** reset closed/wiped the old OPFS database before schema install
  and snapshot application, so a later failure could release the gate after
  losing old durable/poison rows.
- **Important:** feed `needs-bootstrap` selected reset rather than rebase, which
  unnecessarily removed pending and poisoned rows.

RED command:

```text
cd web && pnpm vitest run src/replica/workerHandlers.test.ts src/sync/replicaSync.test.ts
```

Result: exit 1; 2 failed, 19 passed. The injected partial snapshot failure
unexpectedly resolved instead of rolling back, and the feed trace received
`kind: "reset"` instead of the required `kind: "rebase"`.

GREEN changes and evidence:

- Replaced physical wipe/reopen with a logical schema rebuild inside one SQLite
  transaction. FTS triggers are removed before virtual/content tables; schema
  install plus snapshot apply occur in the same transaction. An injected apply
  writes a partial page and throws; the test verifies that page is absent and
  the poisoned pending row plus exact pre-commit content remain.
- Feed recovery now commits `kind: "rebase"`; its existing real SQLite test
  verifies rebase preserves/reapplies pending rows without reset.
- Review-focused worker/client/coordinator command passed 3 files / 33 tests.
- Fresh exact Task 2 command passed 6 files / 76 tests; typecheck and
  `git diff --check` passed.
- Fresh canonical `pnpm verify` passed 69 files / 700 unit tests, production
  build, and Playwright 6/6.
- Focused re-review approved both fixes with no remaining blocker.

## Concerns

No blocking concerns. Like the existing long snapshot RPC, recovery RPC
timeouts do not cancel worker execution at the transport layer; the 120-second
budget materially reduces accidental timeout while waiting behind a long
database operation, and Task 1 disposal still terminates the owned worker on a
terminal lifecycle path.
