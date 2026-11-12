# Sync failure modes and recovery

This doc covers what each guard on the sync path does when a hop fails. The
normal path, including how a window is applied over pending edits, is in
[sync-and-offline.md](sync-and-offline.md).

## Failure modes at a glance

| Failure | Response | Section |
|---|---|---|
| A replica write fails (`SQLITE_CANTOPEN`, `IOERR`, a dead worker) | The op is kept in the in-memory lane; only `ReplicaError.rejected` discards | [A local write fails](#a-local-write-fails) |
| Lane entries and durable rows are both waiting | `headPrecedes` orders them by batch identity | [The in-memory fallback lane](#the-in-memory-fallback-lane) |
| The OPFS file cannot be opened | Up to the attempt limit, then `unusable` for the session | [When the replica cannot be opened](#when-the-replica-cannot-be-opened) |
| The worker RPC breaks | `unreachable`: ops kept, barrier held; the next replica call sets mode `no-replica` | [Availability](#availability), [Replica mode](#replica-mode) |
| The replica opens, then fails every write | The offline banner says unsent changes exist only in memory | [What the UI shows](#what-the-ui-shows) |
| A window was read before an ack deleted its row | Refetched; `PullStarvedError` after the cap | [Windows and the pending queue](sync-and-offline.md#windows-and-the-pending-queue) |
| A pull or a first bootstrap keeps failing | Backoff; `stalled` after `STALL_AFTER_FAILURES` | [A pull that keeps failing](#a-pull-that-keeps-failing) |
| Two repairs or a recovery overlap | Each holds its own barrier owner and releases only that | [The recovery barrier](#the-recovery-barrier) |
| The server answers a terminal 4xx | Row poisoned, delivery paused, snapshot repair drops it | [A batch the server rejects](#a-batch-the-server-rejects) |
| Schema, generation, cursor, FK, title, corruption or repeated window failure | `reset` or `rebase` through `runRecovery` | [Rebootstrap triggers](#rebootstrap-triggers) |
| A rebuild meets page-level file damage, or `pending_ops` cannot be read | The file is replaced; the queue rides in the carry | [Reset, rebase and file replacement](#reset-rebase-and-file-replacement) |
| Pending rows change while recovery runs | Recovery aborts before anything is destroyed | [runRecovery](#runrecovery) |
| A recovery's snapshot download outlasts the lease, or goes silent | Progress renews the lease; a silent download is abandoned and frees the gate | [The recovery lease](#the-recovery-lease) |

## A local write fails

`opQueue` treats a failed replica RPC as a temporary local-persist failure
and keeps the op, unless the replica rejected the op itself
(`ReplicaError.rejected`). The check is that one-entry blocklist, not the
availability type. A starved pool's `SQLITE_CANTOPEN` is neither `unusable`
nor `unreachable`, so a type check would let it reach `onDesync`, whose
repair (`outline/repairEpochs.ts`) wipes the active outline back to the
server's edit-less state. A full disk arrives the same way: the opfs-sahpool
VFS reports `QuotaExceededError` as a bare `SQLITE_IOERR`.

Kept ops join an ordered in-memory fallback lane. Once `noteReplicaFailure`
latches a non-null `availability` from session-fatal evidence, the drain stops
calling `nextBatch()` and delivers only the lane. Durable rows persisted before
the latch wait for a later session, so they reach the server after newer lane
ops. A deferred op still carries its base hash, so it lands as a conflict or a
[missing target](sync-and-offline.md#missing-and-overtaken-targets).

### The in-memory fallback lane

The lane drains under the same connectivity, backoff and recovery-barrier
policy as durable rows. Order between the two is decided by batch identity in
one predicate, `headPrecedes` (`sync/outbox.ts`):

| Durable batch | Goes |
|---|---|
| enqueued while the lane held entries (a mark in `follows`) | after every lane entry appended before it |
| any other row: a previous session's, the shim's `create_page` | ahead of the lane |
| none left (`nextBatch()` returns null) | the lane goes |

Every path that posts durable rows asks the queue first, as the recovery
flush does through `OpQueue.deliverLeased`. A path that skips it can post a
move ahead of the create it depends on.

`opQueue.enqueue` mints the `batch_id` and sets the `follows` mark before the
persist RPC. A reply that times out does not stop the worker storing the row
later, and an unmarked row would go ahead of the whole lane. After a lost
reply the durable row and its lane copy share one id, and whichever arrives
second replays, since `batch_replay_hash` leaves out the fields the worker
fills ([write-path.md § Planning](write-path.md#planning), Idempotency). A
lane copy posts without `seen_seq`, so it is never treated as stale.

A terminal 4xx discards a lane entry and runs `onDesync`'s outline repair
(`sync/outlineRepair.ts`).

A reload destroys the lane, so `useUnloadGuard` (`sync/unloadGuard.ts`) arms
from `onUnsentInMemory`, the lane's own length. Its header gives the guard's
limits, including the iOS standalone PWA, where it does not hold.

## When the replica cannot be opened

Both failure paths are races between an outgoing worker and its replacement.
`openWithRetry` (`replica/openRetry.ts`) and `ensureMinimumCapacity`
(`replica/poolCapacity.ts`) hold the policies.

```mermaid
flowchart TD
    W([replica worker starts])
    B["attempt — up to the attempt limit, with backoff"]
    I["installOpfsSAHPoolVfs, once per worker<br/>(forceReinitIfPreviouslyFailed: true)"]
    C{"pool capacity ≥ MIN_POOL_CAPACITY?"}
    A["addCapacity up to MIN_POOL_CAPACITY<br/>(fresh random filenames)"]
    O["open /pkm-replica.sqlite3"]
    R{"SyncAccessHandle contention,<br/>and attempts left?"}
    OK([replica ready])
    X(["unusable — latched<br/>for the session"])
    W --> B --> I --> C
    C -->|"no: a sibling worker was<br/>mid-create, so capacity is 1"| A --> O
    C -->|yes| O
    O --> OK
    I -.->|throws| R
    A -.->|throws| R
    O -.->|throws| R
    R -->|yes| B
    R -->|no| X
```

`forceReinitIfPreviouslyFailed` must stay in `SAH_POOL_INSTALL_OPTIONS`, and
the top-up to `MIN_POOL_CAPACITY` must run before the open; the comments on
both constants say why. `MIN_POOL_CAPACITY` covers `PEAK_POOL_FILES`, the
most a [file replacement](#reset-rebase-and-file-replacement) holds.

### Availability

The worker decides `ReplicaAvailability` and latches it. `db()` in
`workerHandlers.ts` wraps the first `openDb()` failure in a
`ReplicaUnusableError`, and every later handler call throws it. The latch
lasts the worker's life, because lifting the barrier would start a drain
against a reopened, unexamined database. Only the `close` handler re-arms it,
and only `dispose()` sends `close`, just before it terminates the worker.

| `ReplicaAvailability` | Evidence | Keep the op? | May lift the barrier? |
|---|---|---|---|
| `unusable` | the worker's own `openDb()` failed (`unusable: true` on the wire) | yes | yes |
| `unreachable` | the RPC broke (`RpcLifecycleError`) | yes | no |

A broken RPC tells the client nothing about poisoned rows, so `unreachable`
never lifts the barrier. `availabilityOf()` (`replica/errors.ts`) turns the wire
boolean and the client-side error into one type. `isSessionFatal()` says
whether a consumer may latch it: yes for everything but a bare timeout.

### What the UI shows

`bannerForMode` (`sync/syncState.ts`) folds each mode report into a banner.
Offline, `computeEditability` reads `recovery-failed` as read-only. The
`replica-unusable` banner's action is Reload, not Retry, because the failed
open or dead worker is latched for the session.

A poison problem without its repair outranks an outline one, because its
Retry is what lifts `poison`; the outline problem waits in `outlineBehind`.
With the replica gone, `transitionSync` ranks the banners by whether their
action still works:

| Shown problem | With `SyncState.replicaGone` set | Why |
|---|---|---|
| `replica-stalled` | replaced by `replica-unusable` | Reset needs the replica |
| `rejected-batch` running or failed, `poison-discovery` (`needsWorker`) | replaced by the outline problem in `outlineBehind`, else `replica-unusable` | the repair and discovery run on the worker, so their Retry cannot work and a reload can |
| `rejected-batch` mark-failed | kept | Discard needs no worker, and a replica that never opens fails the same mark after a reload |
| `outline-rejected`, a repaired `rejected-batch` | kept | the outline Retry reads through the server; Dismiss needs nothing |

`replicaGone` brings `replica-unusable` back when a kept problem ends.

`OfflineIndicator.tsx` holds the wording of the `replica-unusable` banner,
which must stay true of unsent work:

| State | The banner says |
|---|---|
| `paused`: `heldForPoison` holds, a `poison` or `startup` claim only a reload releases once the replica is gone | changes are paused until a reload, and names in-memory changes whether connected or not |
| connected | changes are still being saved |
| offline, `unsentInMemory > 0` | names them (`memoryOnlySentence`); Reload asks to confirm |
| the replica opens, then fails every write | no problem banner mounts; the offline `ConnectivityBanner` gives the same warning |

`unsentInMemory` is the lane's share of `pending`, because a reload discards
the lane and durable rows survive it. The session reads the claim from the
queue (`onBarrier`), not from the problem that took it.

## A pull that keeps failing

A failed pull, and a failed `start()` (init, schema recovery or the first
bootstrap), reach `noteFailure`. It retries from `RETRY_BASE_MS` doubling to
`RETRY_MAX_MS`, with no timer while offline; the retry runs whichever of the
two is still owed. A first bootstrap that fails with the socket up must not
wait for the next reconnect, which on a desktop can be hours away.
`isStallShaped` (`sync/syncFailures.ts`) decides whether it counts towards
`STALL_AFTER_FAILURES`:

| Failure | Counts? | Why |
|---|---|---|
| `ApiError`, `ReplicaError`, `PullStarvedError` | yes | the replica cannot make progress |
| `OfflineError`, a raw `fetch` rejection | no | the offline banner owns network-down |
| `StalledReadError` | no | the link went silent; the server refused nothing |
| anything `availabilityOf()` classifies | no | `stalled` would take editing from a session already known to have no replica |

`WINDOW_STRIKES` equals `STALL_AFTER_FAILURES` so that a window failing
identically rebases before the [`stalled`](#replica-mode) banner can show.

## Replica mode

`ReplicaState.mode` (`sync/replicaSync.ts`) is what `computeEditability` and
the offline gateway read: offline, only `ready` may edit or serve reads from
the replica.

| Mode | Entered when | Left when |
|---|---|---|
| `starting` | the provider mounts | `start()` succeeds (`ready`); a failed start is retried on the backoff and may stall |
| `ready` | `start()` succeeds, or a pull or reset succeeds after a report | a report below |
| `stalled` | `STALL_AFTER_FAILURES` counted failures of a pull or a start | a later pull or start succeeds, or Reset local data |
| `recovery-failed` | a `runRecovery` that reports (`reportReplicaFailure`) throws, unless the error is session-fatal (that is `no-replica`) | as `stalled` |
| `no-replica` | `replicaSync.noteUnavailable(error)`, on a session-fatal error at any replica call or the queue's `onUnavailable` latch; or the session's own report when `runtime === null` | never: only a reload brings a new worker |

**A session-fatal error ends replica mode for the session.** A dead worker
leaves its RPC client terminal and a failed open is latched, so every later
call fails the same way. `noteUnavailable` is the one writer of `no-replica`
and of `usable = false`. After it, no retry is armed and no new pass calls
the replica, and `appliedVersion()` reads null, so every reconnect refetches
views. The death is reported at the next replica call, whoever makes it. The
queue's latch (`noteReplicaFailure`, emitted as `onUnavailable`) sees only
the queue's own calls, so `replicaSync` and `clientRuntime` report theirs.

## The recovery barrier

The queue delivers nothing while its barrier has a holder. **Each owner
releases only its own claim**, so one repair finishing never lifts a barrier
another still needs. `BarrierOwner` (`sync/queueState.ts`) is a closed union,
and `pause(owner)` and `resume(owner)` take one:

| Owner | Claimed by | Released by |
|---|---|---|
| `startup` | `clientRuntime.startup()` | `continueStartup`, once discovery answers; on poisoned rows, after `repair()` has claimed `poison` |
| `poison` | before any durable row is marked poisoned, and while retained mark intents or rows startup found await a repair (`rejectDurableBatch`, `deliverLeased`, `markRetainedPoison`, `runRepair`) | a repair that succeeds (`runRepair`), or nothing left to repair, with no repair running (`continueStartup`, `discardPoisonIntents`) |
| `recovery` | `runRecovery`, before its lease | the end of that run, whatever its outcome |
| `lane` | a lane entry's 4xx (`deliverLaneHead`, `deliverLaneAhead`) | the first outline repair to become stable after it (`laneOwed` in `outlineRepair.ts`) |

A recovery's leased flush (`OpQueue.deliverLeased`, lane entries ahead of the
batch included) posts while `lane` holds. The claim only orders the ordinary
drain behind the outline repair, which touches the queue only through
`resume("lane")` and never cancels, rewrites or re-plans a queued op. So a
row's outcome is the same posted then or later; a repair that changed queued
ops would need the flush to stop for `lane` too. An acked leased POST settles
no ticket, so the repair still replays the write it covers. Only `poison` stops
the flush, because a rebase that posts nothing would replay posted rows over
its commit.

`OpQueue.holds(owner)` reports a claim, and `replicaSync` reads
`holds("poison")` as its `holdsPoison` dep
([below](#a-batch-the-server-rejects)). `OpQueue.onRelease` fires
synchronously inside `resume`.

The drain checks the barrier again after each `nextBatch()` read, since a
pause can land while the read waits on the worker's gate.

`onDesync` reports `{ error, lane }`. A local refusal (a text past a limit, a
`ReplicaError.rejected` op) also desyncs, but it paused nothing, so its outline
repair resumes nothing.

### Calls that arrive during a run

`coalesce` (`sync/coalesce.ts`, whose header states the rule) serves the
single-flight sites in the table: a call that arrives during a run joins it
while the site's `joinable()` holds, and is otherwise owed one run.

| Site | A late call joins until | Then owed | Decided by |
|---|---|---|---|
| `start` (`replicaSync.ts`) | always: the run's own pull follows | nothing | `joinable: () => true` |
| `pull` (`replicaSync.ts`) | never: a pass may be past its fetch | a pass of its own | `joinable` omitted |
| reconnect completion (`reconnectFlow.ts`) | the resync decision | a completion of its own | `deciding` |
| poison repair (`clientRuntime.ts`) | the delete loop reads its targets | a repair, with the events merged | `deleting` |
| outline repair (`outlineRepair.ts`) | `onStable`: a later run read too early | a run, under the latest error | `stable` |

The flag that decides must flip in the same step as the read it guards, or
a call can still land between the read and the flip. A site whose calls can
be owed checks its owner is still live at the top of its run, because an
owed run can start after the session is disposed. `opQueue.drain` keeps its
own rule (`drainAgain`), because it reruns only on some outcomes and never
over an armed retry.

## A batch the server rejects

`isTerminalRejection` (`sync/rejection.ts`) decides, at each delivery site in
`opQueue.ts` (the drain's durable and lane deliveries, and a recovery's leased
POST in `deliverLeased`, lane entries ahead included), whether a failure
means the batch itself is bad:

| Answer | Terminal? | Outcome |
|---|---|---|
| 4xx other than 401, 403, 408, 429 | yes | durable row poisoned; lane entry discarded |
| 401, 403, 408, 429 | no | retained under backoff: a session expiry or a cleared cookie says nothing about the batch. `apiFetch` still redirects a 401 to `/login` |
| 5xx, network failure, `OfflineError` | no | retained under backoff |

A batch can meet a 400 its replica could not foresee, such as two devices'
edits stacking past the
[depth cap](write-path.md#work-bounds-under-the-write-lock); the rebase
below then drops its valid ops with the deep one.

A poisoned row pauses delivery, and `clientRuntime.ts` runs
`rebaseAuthoritative`: a `rebase` with flush `"skip"` over a fresh snapshot,
then deletes the poisoned row by id. It never resets, which would drop the
valid rows behind the poisoned one, and never posts them first. It gets past a
damaged file by [file replacement](#reset-rebase-and-file-replacement).

Since it posts nothing, no normal flush may post past the poisoned row, or the
rebase would replay those rows over their commits:

| Guard | Where |
|---|---|
| `rejectDurableBatch`, and `deliverLeased` on a leased 4xx, pause `poison` before the durable mark. The flush's `beforePost` reads `holdsPoison()` before every leased batch, and `deliverLeased` reads it again after the lane ahead | `opQueue.ts`, `replicaSync.ts` |
| Startup repairs poisoned rows left by an earlier page load before `replicaSync.start()` | `clientRuntime.ts` |

`deliverLeased` claims `poison` synchronously, fails its ticket, starts
`markRetainedPoison` without awaiting it, and throws. It cannot await the
mark: `markPoisoned` passes the worker gate, which the run's own recovery lease
holds, so the mark lands once the run aborts. Because it throws, the row's
ack never reaches `heldAcks`, and the commit leaves the row for the poison
repair. A lane entry ahead that the server rejects is discarded as in the
drain, and the flush goes on.

A failed repair keeps the barrier and a Retry banner. It usually failed
offline, so every socket connect retries it too:

| Repair | Retried by | Banner |
|---|---|---|
| Poison repair | Retry (`retryPolicy.ts::planRetry`'s `repair-targets`), and each connect's `clientRuntime.retryFailedRepair()` | rejected-batch |
| Lane batch's outline repair | Retry, and each connect's `outlineRepair.retryFailed()` | `outline-rejected` |

Only a connect retries, never a drain observed while connected, so a repair
that fails again waits for the next connect instead of looping. The targets of
a failed run carry into the next, merged by `orderedPoisonEvents`
(`sync/poisonIntents.ts`).

Mark intents live in `localStorage` (`sync/poisonIntentStore.ts`,
`pkm.poison-mark-intents.v1`), so they survive an unopenable database. A failed
`retryPoisonMarks()` keeps the barrier, with Retry and "Discard rejected
change" (`Sync.discardProblem()`).

A successful `markPoisoned` fires `onPoison`, which starts the repair. A mark
RPC that fails keeps the `poison` claim, because the row is still unmarked.
While the claim is held, a pull pass that needs a recovery leaves it to the
repair, and one more pull is owed for the claim's release (`owePoisonPull`
in `replicaSync.ts`).

## Rebootstraps

A rebootstrap rebuilds the replica from a server snapshot through
`runRecovery`.

### Rebootstrap triggers

| Trigger | Detected by | Kind |
|---|---|---|
| A deploy changed the client schema | `SCHEMA_VERSION` (sha256 of base and client DDL) differs from the stored value | `reset` |
| The server DB was rebuilt (import) or restored (`pkm.backup.restore`), or activation rotated the generation | `generation` mismatch in any payload | `rebase` |
| Cursor ahead of the journal | `reset: true` from the feed | `rebase` |
| The deferred FK check fails at COMMIT | `applyChanges` returns `needs-bootstrap` | `rebase` |
| A title stays parked after the upserts | `assertNoParkedTitles` throws `StaleTitleHolderError`, then `needs-bootstrap` | `rebase` |
| Corruption (`SQLITE_CORRUPT`, `SQLITE_CORRUPT_VTAB`) applying a window or snapshot | `isCorruptionError`, once per session, after posting `replica.diagnostics()` to `POST /api/client/diagnostics` | `reset`: a rebase would replay through the same corrupt FTS index |
| One cursor fails `WINDOW_STRIKES` times with one message | `isWindowFailure`, which counts only a `ReplicaError` that is neither corruption nor availability; posted as `window-unappliable` | `rebase`, which keeps the queue |

The poison repair and the user's Reset local data also rebootstrap.

### runRecovery

`runRecovery` (`sync/replicaSync.ts`) is the single lifecycle behind every
rebootstrap:

```mermaid
flowchart TD
    P["queue.pause('recovery')"] --> AW{"awaitInFlightPull?"}
    AW -->|yes| WP["await the start and the pull in flight"] --> L
    AW -->|no| L
    subgraph G["worker gate held: every other replica call waits"]
        L["replica.prepareRecovery()<br/>pending rows fingerprinted<br/>deadline: call time + RECOVERY_LEASE_MS"]
        L --> F["flushLease: skip · preemptible · blocking<br/>each ack held as { id, batch_id, seq }<br/>progress renews the lease"]
        F --> S["GET /api/sync/snapshot<br/>progress renews the lease"]
        S --> C{"commitRecovery:<br/>lease live, pending rows unchanged?"}
        C -->|"yes, reset"| RB["rebuildOrReplaceFile"]
        C -->|"yes, rebase"| RS["rebaseOrReplaceFile<br/>acked rows deleted in the snapshot's transaction"]
    end
    X(["no renewal for RECOVERY_LEASE_MS:<br/>the worker frees the gate"]) -.-> G
    RB --> OK["adoptCursor(snapshot.seq)"]
    RS --> OK
    C -.->|no| AB["abortRecovery(token), rethrow"]
    F -.->|"throws, or a renewal was refused"| AB
    S -.->|"SNAPSHOT_STALL_MS of silence,<br/>throws, or a renewal was refused"| AB
    OK --> R["finally: queue.resume('recovery')"]
    AB --> R
```

| `RecoveryOptions` | schema / feed recovery | poison repair | manual reset |
|---|---|---|---|
| `flush` | `"preemptible"`: abandon if a poison mark claims recovery | `"skip"`: never post valid rows ahead of a refused batch | `"blocking"`: a failed flush raises `ResetBlockedError`, unless the lease was lost, since discarding the queue would not win it back, or a poison claim landed, which refuses as "rejected-batch repair in progress"; `"skip"` if the user discards pending changes |
| `reportReplicaFailure` | yes, mode `recovery-failed` | no | no |
| `awaitInFlightPull` | no | yes | yes |
| `forceReadyOnSuccess` | no | no | yes |

These guards keep a recovery from destroying an edit enqueued while it runs:

| Guard | Where |
|---|---|
| A worker-owned FIFO recovery gate that every database-mutating RPC passes, so no enqueue lands mid-rebuild. A lease that expires frees the gate, and its commit is refused | `recoveryGate.ts`, `workerHandlers.ts` |
| `prepareRecovery` fingerprints the durable pending rows; `commitRecovery` re-reads them before the destructive step and aborts if they changed | `workerHandlers.ts` |

A pull in flight must finish before the database is torn down, or its stale
window lands after the snapshot and moves the cursor back. Feed recovery cannot
await it, since `pullLoop` calls it from inside that pull; it runs through
`recover()`, which turns a `rebase` failing on fresh corruption into a
`reset`.

**Within a session, a rebase never replays a batch its flush got an ack for.**
The server's result can differ from the wire op. The next pull starts at the
snapshot's seq, so nothing would correct a replay of the wire text.
`flushBatches` holds each ack in `heldAcks` (`sync/opsAck.ts`), across runs
until a commit takes them. `splitAckedRows` (`replica/ackedRows.ts`) deletes
the matching rows in the snapshot's transaction. Held acks are memory only, so
after a reload the rows replay once and the stored ack deletes them.

### The recovery lease

The lease bounds the gate span in the diagram above. Its first deadline
counts from the `prepareRecovery` call, so the wait for the gate counts
against it, and a run whose wait outlasted `LEASE_RENEW_EVERY_MS` renews as
soon as it is granted. `keepLease` (`replicaSync.ts`) renews it through
`renewRecovery`, at most once per `LEASE_RENEW_EVERY_MS`.

**The lease is renewed on progress (a flush ack, snapshot bytes), never on a
timer.** A flush POST that hangs is never aborted, and a page that stops
running sends nothing. Either stops renewing, and the worker frees the gate a
lease-length later. A heartbeat would hold the gate for as long as a hung
POST lasts.

A download silent for `SNAPSHOT_STALL_MS` is abandoned by the client, which
frees the gate itself. `SNAPSHOT_STALL_MS + LEASE_RENEW_EVERY_MS` stays
under `RECOVERY_LEASE_MS`, so a live client gives the gate back before the
worker has to; `replicaSync.test.ts` pins the inequality. A lease call is
refused once the lease has expired (`LEASE_EXPIRED`) or its commit has begun
(`INVALID_TOKEN`); `recoveryLease.props.test.ts` holds the cases.

An edit made during the gate span waits behind it. Its enqueue times out into
the [in-memory lane](#the-in-memory-fallback-lane), which the `recovery`
barrier also holds, so the edit exists only in memory until the gate frees.

### Reset, rebase and file replacement

A `reset` rebuilds the tables inside the file in one transaction
(`rebuildSchema`), so a failure leaves the old database whole. Damage to the
file itself survives that, so on a corruption error `rebuildOrReplaceFile`
(`replica/workerHandlers.ts`) unlinks the file (`discardDbFile`) and rebuilds
on a fresh one.

A `rebase` meets the same damage when its snapshot deletes rows.
`rebaseOrReplaceFile` takes the same escape but keeps the queue. **The carry
commits before the damaged file is unlinked.** The rows no ack covers travel
verbatim to `/pkm-replica-carry.sqlite3` (`carryStore.ts`), ids and
`poisoned` included, because the runtime deletes the poisoned row by id
afterwards. The new file imports them by id (`importPendingRows`). The carry
is discarded as soon as that import commits, before the snapshot applies,
because a carry kept past a failed snapshot would later bring back batches
acked since. `rebaseOrReplaceFile`'s docstring walks where the rows are at
each step.

Every queue handler reaches the database through `queueDb`, which adopts a
leftover carry first. Otherwise an edit reaching a restarted worker would
take the carried ids, and the by-id import would drop those rows. The
recovery internals (`rebuildOrReplaceFile`, `rebaseOrReplaceFile`,
`replaceUnreadableQueue`) and `diagnostics` use `db()` instead, because
mid-replacement the carry is the rows' only copy. `adoptLeftoverCarry`'s
docstring covers adoption's failure cases; no row is lost unless both files
are damaged at once.

A queue that cannot be read takes the same escape. `withQueue` treats a
handler's corruption error as that case when a plain read of `pending_ops`
fails too. It carries the rows that can still be read (`salvagePendingRows`,
the prefix before the damage, merged with any carry), replaces the file, and
runs the handler again. Without it init, `prepareRecovery` and the drain's
`nextBatch` fail on every page load, so neither Reset local data nor the
lane gets past them. Corruption elsewhere, such as the FTS index, leaves the
queue readable and keeps its own repair.

Corruption must reach `isCorruptionError` with its own message, so
`wrapSqlite`'s `transaction` and `rollbackToSavepoint` (`replica/db.ts`) raise
the original error when SQLite has already rolled back. A masked message
looks like an unappliable window, which triggers a rebase over the same
damaged file.
