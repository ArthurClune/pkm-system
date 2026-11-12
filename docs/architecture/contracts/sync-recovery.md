# Contract: sync recovery

What each guard on the web sync path does when a hop fails, case by case.
`web/src/props/sync/queueModel.ts`, `web/src/props/sync/bannerModel.ts`, the
sync oracle's order, mode and lease checks (`oracle.ts`, `conflictNoise.ts`,
`settle.ts`), `web/src/replica/recoveryLease.props.test.ts` and
`web/src/replica/queueUnreadable.props.test.ts` are written from this file
and never from the code, so a change in behaviour edits the row here and the
model together. Each section's principle, and why it holds, is in
[sync-recovery.md](../sync-recovery.md) under the same section name; a
reason that belongs to one row sits in that row.

## A local write fails

| A replica RPC fails with | `opQueue` |
|---|---|
| `ReplicaError.rejected`: the replica rejected the op itself | discards the op |
| anything else, a starved pool's `SQLITE_CANTOPEN` and a full disk's bare `SQLITE_IOERR` included | keeps the op in the ordered [in-memory fallback lane](#the-in-memory-fallback-lane) |

Once `noteReplicaFailure` latches a non-null `availability` from
session-fatal evidence:

| What | Then |
|---|---|
| the drain | stops calling `nextBatch()` and delivers only the lane |
| durable rows persisted before the latch | wait for a later session, so they reach the server after newer lane ops |
| a deferred op | still carries its base hash, so it lands as a conflict or a [missing target](../sync-and-offline.md#missing-and-overtaken-targets) |

## The in-memory fallback lane

The lane drains under the same connectivity, backoff and recovery-barrier
policy as durable rows. `headPrecedes` (`sync/outbox.ts`) orders the two:

| Durable batch | Goes |
|---|---|
| enqueued while the lane held entries (a mark in `follows`) | after every lane entry appended before it |
| any other row: a previous session's, the shim's `create_page` | ahead of the lane |
| none left (`nextBatch()` returns null) | the lane goes |

| Situation | Outcome |
|---|---|
| any path that posts durable rows | asks the queue first; the recovery flush does through `OpQueue.deliverLeased`, posting the lane entries a batch follows ahead of it |
| `opQueue.enqueue` | mints the `batch_id` and sets the `follows` mark before the persist RPC |
| a persist reply is lost | the durable row and its lane copy share one id, and whichever arrives second replays, since `batch_replay_hash` leaves out the fields the worker fills ([write-path.md § Planning](../write-path.md#planning), Idempotency) |
| a lane copy posts | without `seen_seq`, so it is never treated as stale |
| a terminal 4xx on a lane entry | discards it and runs `onDesync`'s outline repair (`sync/outlineRepair.ts`) |
| a reload | destroys the lane; `useUnloadGuard` (`sync/unloadGuard.ts`) arms from `onUnsentInMemory`, the lane's own length |

## What the UI shows

| Problems at once, replica present | Shown | Reason |
|---|---|---|
| a poison problem without its repair, and an outline problem | the poison problem; the outline problem waits in `outlineBehind` | |
| a poison problem in any phase, `repaired` included, and a stalled replica, in either order | the poison problem. A poison event replaces `replica-stalled` (`poisonProblem`; `poisonEnded` for `repaired`), and a stall report leaves any other problem shown (`replicaStalled`) | the stall report is a background one, made again at each failed retry while online (`noteFailure` in `replicaSync.ts`) |
| an outline problem and a stalled replica | the outline problem (`outline` replaces `replica-stalled`) | the same background stall report |
| a poison problem ends to nothing (a failed mark discarded, a discovery cleared) while the replica is still stalled | `replica-stalled`, idle, with the error in `SyncState.stalled` (`poisonEnded`) | the poison problem only outranked the stall, which is still true |
| a `repaired` notice, poison or outline, dismissed while the replica is still stalled | the same (`dismiss`) | the same |
| a `blocked` or `failed` reset outcome dismissed | nothing, until the next stall report raises `replica-stalled` idle again (`replicaStalled`) | the user has acknowledged the stall itself |

`SyncState.stalled` holds the latest stall report's error whichever problem
shows. A ready or no-replica report and `reset-succeeded` clear it. So the
stalled banner goes only when the stall ends or the user dismisses a reset's
outcome, never because another problem came and went.

With the replica gone, `transitionSync` ranks the banners by whether their
action still works:

| Shown problem | With `SyncState.replicaGone` set | Why |
|---|---|---|
| `replica-stalled` | replaced by `replica-unusable` | Reset needs the replica |
| `rejected-batch` running or failed, `poison-discovery` (`needsWorker`) | replaced by the outline problem in `outlineBehind`, else `replica-unusable` | the repair and discovery run on the worker, so their Retry cannot work and a reload can |
| `rejected-batch` mark-failed | kept | Discard needs no worker, and a replica that never opens fails the same mark after a reload |
| `outline-rejected`, a repaired `rejected-batch` | kept | the outline Retry reads through the server; Dismiss needs nothing |

`replicaGone` brings `replica-unusable` back when a kept problem ends.

The `replica-unusable` banner's wording (`OfflineIndicator.tsx`):

| State | The banner says |
|---|---|
| `paused`: `heldForPoison` holds, a `poison` or `startup` claim only a reload releases once the replica is gone | changes are paused until a reload, and names in-memory changes whether connected or not |
| connected | changes are still being saved |
| offline, `unsentInMemory > 0` | names them (`memoryOnlySentence`); Reload asks to confirm |
| the replica opens, then fails every write | no problem banner mounts; the offline `ConnectivityBanner` gives the same warning |

`unsentInMemory` is the lane's share of `pending`. The session reads the
claim from the queue (`onBarrier`), not from the problem that took it.

## Replica mode

Offline, only `ready` may edit or serve reads from the replica.

| Mode | Entered when | Left when |
|---|---|---|
| `starting` | the provider mounts | `start()` succeeds (`ready`); a failed start is retried on the backoff and may stall |
| `ready` | `start()` succeeds, or a pull or reset succeeds after a report | a report below |
| `stalled` | `STALL_AFTER_FAILURES` counted failures of a pull or a start | a later pull or start succeeds, or Reset local data |
| `recovery-failed` | a `runRecovery` that reports (`reportReplicaFailure`) throws, unless the error is session-fatal (that is `no-replica`) | as `stalled` |
| `no-replica` | `replicaSync.noteUnavailable(error)`, on a session-fatal error at any replica call or the queue's `onUnavailable` latch; or the session's own report when `runtime === null` | never: only a reload brings a new worker |

| After `noteUnavailable` | Outcome |
|---|---|
| retries | none is armed |
| a new pass | does not call the replica |
| `appliedVersion()` | reads null, so every reconnect refetches views |
| the worker's death | reported at the next replica call, whoever makes it: the queue's latch (`noteReplicaFailure`, emitted as `onUnavailable`), `replicaSync` or `clientRuntime` |

## The recovery barrier

The queue delivers nothing while its barrier has a holder, and each owner
releases only its own claim.

| Owner | Claimed by | Released by |
|---|---|---|
| `startup` | `clientRuntime.startup()` | `continueStartup`, once discovery answers; on poisoned rows, after `repair()` has claimed `poison` |
| `poison` | before any durable row is marked poisoned, and while retained mark intents or rows startup found await a repair (`rejectDurableBatch`, `markRetainedPoison`, `runRepair`) | a repair that succeeds (`runRepair`), or nothing left to repair, with no repair running (`continueStartup`, `discardPoisonIntents`) |
| `recovery` | `runRecovery`, before its lease | the end of that run, whatever its outcome |
| `lane` | a lane entry's 4xx (`deliverLaneHead`) | the first outline repair to become stable after it (`laneOwed` in `outlineRepair.ts`) |

| POST | Held back by |
|---|---|
| the ordinary drain, durable rows and lane entries alike | any owner |
| a recovery's leased flush (`OpQueue.deliverLeased`, lane entries ahead of the batch included) | `poison` only; it posts while `lane` holds |

## A batch the server rejects

`isTerminalRejection` (`sync/rejection.ts`), at both delivery sites in
`opQueue.ts`:

| Answer | Terminal? | Outcome |
|---|---|---|
| 4xx other than 401, 403, 408, 429 | yes | durable row poisoned; lane entry discarded |
| 401, 403, 408, 429 | no | retained under backoff: a session expiry or a cleared cookie says nothing about the batch. `apiFetch` still redirects a 401 to `/login` |
| 5xx, network failure, `OfflineError` | no | retained under backoff |

| Poison mark | Outcome |
|---|---|
| `markPoisoned` succeeds | fires `onPoison`, which starts the repair |
| the mark RPC fails | the `poison` claim stays, because the row is still unmarked |
| `retryPoisonMarks()` fails | the barrier stays, with Retry and "Discard rejected change" (`Sync.discardProblem()`) |
| a pull pass needs a recovery while the claim is held | it leaves the recovery to the repair, and one more pull is owed for the claim's release (`owePoisonPull` in `replicaSync.ts`) |

A failed repair keeps the barrier and a Retry banner:

| Repair | Retried by | Banner |
|---|---|---|
| Poison repair | Retry (`retryPolicy.ts::planRetry`'s `repair-targets`), and each connect's `clientRuntime.retryFailedRepair()` | rejected-batch |
| Lane batch's outline repair | Retry, and each connect's `outlineRepair.retryFailed()` | `outline-rejected` |

Only a connect retries, never a drain observed while connected. The targets
of a failed run carry into the next, merged by `orderedPoisonEvents`
(`sync/poisonIntents.ts`).

## Rebootstrap triggers

| Trigger | Detected by | Kind |
|---|---|---|
| A deploy changed the client schema | `SCHEMA_VERSION` (sha256 of base and client DDL) differs from the stored value | `reset` |
| The server DB was rebuilt (import) or restored (`pkm.backup.restore`), or activation rotated the generation | `generation` mismatch in any payload | `rebase` |
| Cursor ahead of the journal | `reset: true` from the feed | `rebase` |
| The deferred FK check fails at COMMIT | `applyChanges` returns `needs-bootstrap` | `rebase` |
| A title stays parked after the upserts | `assertNoParkedTitles` throws `StaleTitleHolderError`, then `needs-bootstrap` | `rebase` |
| Corruption (`SQLITE_CORRUPT`, `SQLITE_CORRUPT_VTAB`) applying a window or snapshot | `isCorruptionError`, once per session, after posting `replica.diagnostics()` to `POST /api/client/diagnostics` | `reset` |
| One cursor fails `WINDOW_STRIKES` times with one message | `isWindowFailure`, which counts only a `ReplicaError` that is neither corruption nor availability; posted as `window-unappliable` | `rebase`, which keeps the queue |

## The recovery lease

The lease bounds the worker gate span in
[runRecovery's diagram](../sync-recovery.md#runrecovery).

| Situation | Outcome |
|---|---|
| the first deadline | counts from the `prepareRecovery` call, so the wait for the gate counts against it |
| a run whose wait for the gate outlasted `LEASE_RENEW_EVERY_MS` | renews as soon as the gate is granted |
| progress: a flush ack, snapshot bytes | `keepLease` (`replicaSync.ts`) renews through `renewRecovery`, at most once per `LEASE_RENEW_EVERY_MS` |
| no progress: a flush POST that hangs (never aborted), a page that stops running | no renewal; the worker frees the gate a lease-length later |
| a snapshot download silent for `SNAPSHOT_STALL_MS` | the client abandons it and frees the gate itself |
| a lease call once the lease has expired | refused, `LEASE_EXPIRED` |
| a lease call once its commit has begun | refused, `INVALID_TOKEN` |

`SNAPSHOT_STALL_MS + LEASE_RENEW_EVERY_MS` stays under `RECOVERY_LEASE_MS`.

## Reset, rebase and file replacement

| Damage | Escape |
|---|---|
| a `reset`'s rebuild fails | none needed: `rebuildSchema` rebuilds the tables in one transaction, so the old database stays whole |
| a `reset` meets a corruption error | `rebuildOrReplaceFile` (`replica/workerHandlers.ts`) unlinks the file (`discardDbFile`) and rebuilds on a fresh one |
| a `rebase`'s snapshot deletes rows from a damaged file | `rebaseOrReplaceFile` replaces the file and keeps the queue, through the carry |
| a handler's corruption error, when a plain read of `pending_ops` fails too (`withQueue`) | the rows that can still be read are carried (`salvagePendingRows`: the prefix before the damage, merged with any carry), the file is replaced, and the handler runs again |
| corruption elsewhere, such as the FTS index | the queue stays readable and the damage keeps its own repair |

The carry, `/pkm-replica-carry.sqlite3` (`carryStore.ts`):

| Step | Rule |
|---|---|
| what it holds | the rows no ack covers, verbatim, ids and `poisoned` included |
| the damaged file is unlinked | only after the carry commits |
| the new file | imports the rows by id (`importPendingRows`) |
| that import commits | the carry is discarded, before the snapshot applies |
| a queue handler | reaches the database through `queueDb`, which adopts a leftover carry first |
| `rebuildOrReplaceFile`, `rebaseOrReplaceFile`, `replaceUnreadableQueue`, `diagnostics` | use `db()`, never `queueDb` |
| both files damaged at once | the only case in which a row is lost |
