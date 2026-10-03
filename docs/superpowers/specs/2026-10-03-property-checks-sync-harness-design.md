# Property checks: sync protocol harness (pkm-yxcs)

Agreed with Arthur 2026-10-03. Second of four sub-projects under the epic
pkm-nws9 (property-based sync checks); the first, the gate and server suite
(pkm-svgx), is merged. The others are client/server op divergence
(pkm-j3ui) and outline edit commands (pkm-f7zv).

## Problem

The sync path's guards — idempotent batch ids, the durable queue, the
in-memory fallback lane, poison repair, rebase recovery, reload — are each
pinned by example tests with fakes. Nothing drives the real client stack
against the real server under random interleavings of faults, so a
composition bug between two guards (a lost ack during a recovery flush, a
nudge-started pull racing a drain, a reload with a poisoned row) is found
only in production.

## Outcome

- `proptest/check.sh web` runs a fast-check model-based suite that drives
  the real web sync stack, in Node over real sqlite-wasm, against a real
  server over HTTP, with faults injected at a per-client transport.
- At quiescence every client has converged with the server, every batch a
  client enqueued landed exactly once, and a fault-free serial replay of
  those batches reproduces the server's state.
- Budget: about 3 minutes for the web side, on top of the server side's 3.
  Each sub-project's suite brings its own budget, so the gate's total grows
  as suites are added (Arthur, 2026-10-03; recorded on pkm-nws9).
- The failure policy is the epic's: a product bug is fixed with the shrunk
  case as an ordinary unit test (vitest, or pytest if the bug is
  server-side); a wrong property is fixed in `props/`; a flaky property
  gets a bean against the gate.

Out of the oracle's reach on purpose: what a batch does to the tree. Op
semantics, conflict copies included, are the server suite's job
(pkm-svgx). This suite checks delivery: that the right batches reach the
server, once each, in an order a fault-free run reproduces, and that every
client ends up seeing the result.

## Shape

```
proptest/check.sh web
  └─ server/tooling/proptest/run.py   (web runner)
       ├─ launches  server/tooling/proptest/sync_server.py  on :8978
       └─ runs      cd web && pnpm exec vitest run --config vitest.props.config.ts
                      └─ web/src/props/sync/*.prop.ts
                           fc.asyncModelRun over 2–3 harness clients, each:
                           sqlite-wasm DB → buildHandlers → createReplica
                           → createOpQueue(replica, deps) → createReplicaSync
                           → createClientRuntime → createReconnectFlow
                           + its own faulty transport → real HTTP → :8978
```

The `.prop.ts` suffix keeps the suite out of vitest's default include, so
`pnpm test:unit`, coverage and `pnpm verify` never run it.

There is no WebSocket. The socket's only correctness-relevant outputs are
calls to `replicaSync.onSeq(seq, force)` and the online/offline transitions
that drive `queue.setOnline` and `reconnect.begin`; op echoes never touch
the replica. The harness makes those calls itself: `Online`/`Offline` for
the transitions, `Pull` for an awaited catch-up, and `Nudge` for an
un-awaited `onSeq` with a real, stale, duplicate or future seq. Running with
no frames at all tests that correctness never needs one; `Nudge` tests that
frames which do arrive, at any moment, cannot hurt. `ws.py` and `socket.ts`
themselves stay with their unit tests.

## Server: `sync_server.py`

Test tooling under `server/tooling/proptest/`, never part of the product
app's `create_app`. It builds the app the way `server/tests/e2e_serve.py`
does — fixed password, parent-death watch, `/healthz`, a stub `index.html`
dist so no build is needed — binds **8978**, and adds:

| Piece | Design |
|---|---|
| Template DB | Built once at startup: the schema plus one seeded page of about six blocks at gapped `order_idx`. Every reset copies it |
| Clock | A controllable clock with `time_machine`, not ticking on its own. Every server-side `time.time()` / `datetime.now()` reads it. Starts at a fixed midday |
| `POST /__proptest/reset` | Copies the template to a new file and points `app.state.config.db_path` at it. The server opens a connection per request (`db.get_db`), so this gives each example a fresh DB without a restart. Planning checks that no other `app.state` cache outlives the swap; any that does is cleared here |
| `POST /__proptest/clock` | Sets the clock to a given epoch ms |
| `POST /__proptest/rotate-generation` | `sync_meta.rotate_database_generation`. Every client's next pull returns `needs-bootstrap`, which runs the real rebase recovery |
| `GET /__proptest/applied` | `applied_batches` in commit (rowid) order: `batch_id`, `applied_at` |

The routes need the session cookie like any other route.

## Client: seams and the extracted runtime

### `createOpQueue(replica, deps?)`

An optional `OpQueueDeps`; every field defaults to today's behaviour, so
`SyncProvider`'s call is unchanged.

| Dep | Default | Why |
|---|---|---|
| `post(body)` | `apiPost("/api/ops", …)` | per-client transport and faults |
| `clientId` | the module's `clientId` | distinct clients in one process |
| `poisonStore` | the localStorage store (`poisonIntentStore.ts`) | no shared poison-intent key |
| `newBatchId()` | `newRawUid` | the harness knows every batch id at enqueue time, so a batch that is never sent is detectable; ids are reproducible under a seed |

### `sync/clientRuntime.ts`

Extracted from `SyncProvider.tsx` as a behaviour-preserving refactor, the
first build task: the startup gate (`setOnline(false)`, `pause`,
`retryPoisonMarks`, `poisonedBatches`, repair or `resume`, `start`) and the
poison-repair coalescing (`repairEventsRef` and its refs). Ref-held state
becomes closure state with an explicit `dispose()` that stands in for
`mountedRef`. UI effects (`applySync`, `setReplicaState`,
`queue.refreshPending`) become injected callbacks, called in the same order
as today. `SyncProvider` becomes an adapter over it.

Gate for the refactor: `SyncProvider.test.tsx` passes unmodified, and a new
`clientRuntime.test.ts` covers the dispose-mid-startup and
concurrent-poison-coalescing paths directly.

### Harness client

One per simulated device:

- an in-memory sqlite DB (`testDb`'s opener) that survives reloads;
- `buildHandlers({ openDb })` served over a `MessageChannel`, and
  `createReplica` on the other port, as `replicaSync.ackedReplay.test.ts`
  does;
- `createOpQueue(replica, deps)`, `createReplicaSync({ fetchJson, … })`,
  `createClientRuntime`, `createReconnectFlow`.

**Reload** disposes everything except the DB, rebuilds the rest, and runs
the runtime's startup, as a page load does: the worker's `ackedSeqs` and
`replicaSync`'s held acks are lost, as they are in a real reload.

### Transport

One per client, serving both the queue's `post` and `replicaSync`'s
`fetchJson`. It prefixes the base URL, adds the session cookie, and applies
one-shot faults from a queue:

| Fault | Effect |
|---|---|
| offline | Throws a network error without sending |
| `dropAck` | The `POST /api/ops` reaches the server and commits; the reply is replaced by a network error |
| `duplicate` | The same request is sent twice; the second reply is returned |
| `lostPull` | As `dropAck`, on `GET /api/sync/changes` or `/snapshot` |
| `writeFails` | Not a transport fault: the client's `openDb` wrapper fails the next local write (as `testDb.failingOnce`), sending ops to the in-memory fallback lane |

The transport records every `POST /api/ops` body by batch id, for the
serial replay.

## Command model

`fc.commands` under `fc.asyncModelRun`. Each example resets the server,
starts 2 or 3 clients bootstrapped from the template, and runs up to about
30 commands. The model tracks only which clients are online, which batch
ids are expected to land, which are expected to be rejected, and each
client's unsent-in-memory count. The expected tree is the oracle's job, not
the model's.

| Command | Does | Notes |
|---|---|---|
| `Edit(c, ops)` | Enqueues 1–4 raw ops (`create`, `update_text`, `move`, `delete`, `set_collapsed`) over a uid pool shared by all clients, with base hashes left undefined so the worker stamps them from that client's replica | Awaits persistence only; delivery runs in the background, as in the app. Its batch id joins the expected set |
| `BadBatch(c)` | Enqueues a `create` of a uid already live in that client's replica: the replica keeps it in place as a replay (`placementFor`), the server rejects it with a 400 | About 1 in 30. Expected poisoned, then repaired. Only on the durable path: precondition no armed `writeFails` and nothing unsent in memory |
| `Offline(c)` / `Online(c)` | `queue.setOnline` and `reconnect.begin`, as `useSocketLifecycle` does | |
| `Fault(c, kind)` | Arms one `dropAck`, `duplicate`, `lostPull` or `writeFails` | |
| `Pull(c)` | Pulls to the server's latest seq and awaits it | |
| `Nudge(c, kind)` | `replicaSync.onSeq` with the latest, a stale, a duplicate or a future seq, not awaited | So pulls overlap drains and acks |
| `Reload(c)` | Rebuilds the client and runs startup | Precondition: nothing unsent in memory. A reload with lane-only ops loses them by design; that is the `beforeunload` guard's job |
| `RotateGeneration` | `POST /__proptest/rotate-generation` | Every client's next pull runs rebase recovery |
| `CrossMidnight` | Moves the server clock to 23:59:5x, then past midnight | Rare. Sometimes on a BST/GMT changeover date; the gate runs under `TZ=Europe/London` |

The client sync code reads no dates (the worker's `nowMs` only times
recovery leases), so the server clock is the only one that matters.

**Timing.** Background drains and un-awaited nudges race real HTTP, and
backoff timers are real. Command sequences replay exactly under a seed;
timing does not. A failure that does not reproduce on the same seed and
path is a flaky property under the epic's policy: a bean against the gate.
The failure report always prints the full command list, so an unshrunk
failure is still readable.

## Quiescence and the oracle

**Quiescence.** Clear every fault, put every client online, then repeat
`drain()` and a pull on every client until no client has a pending row, a
lane entry or a recovery in flight, and every cursor equals the server's
`latest_seq`. Planning checks whether an explicit `drain()` bypasses the
retry backoff; if it does not, quiescence waits it out. The loop has a
wall-clock limit, and not settling within it is itself a failure
(liveness).

Then:

| # | Invariant | Catches |
|---|---|---|
| 1 | **Convergence.** Each replica's graph tables — blocks (`uid`, page title, `parent_uid`, `order_idx`, `text`, `heading`, `collapsed`, `view_type`), pages by title, refs by block uid and target title — equal the server's snapshot, normalised the same way | A missed window, a bad apply, a stuck optimistic ghost. Checking only at quiescence absorbs the two transient `keepSlot` misorderings in `sync-recovery.md § Recovery never erases intent` |
| 2 | **Accounting.** The set of `applied_batches` ids equals the set of `Edit` batch ids. Every `BadBatch` was reported through `onPoison`, repaired, and is absent from `applied_batches`. No pending or poisoned rows remain | A batch lost before or after enqueue, a batch applied under a second id, a poison with no terminal rejection, a rejection never repaired |
| 3 | **Serial replay.** Reset the server, then for each applied batch in commit order, set the clock to its `applied_at` and post its recorded body. The resulting snapshot equals the faulted run's | Doubled or reordered application, and any state a fault left that a clean run would not |
| 4 | **Per-client order.** Each client's batches appear in `applied_batches` in the order that client enqueued them, across the lane, reloads and recovery flushes | A batch delivered ahead of one its client enqueued earlier. Serial replay cannot see this: it replays the server's commit order, swap included |
| 5 | **Cursor monotonic.** Checked after every command, per client, across reloads and recoveries | A rewind that would re-apply or skip a window |
| 6 | **No unexplained desync or poison.** No `onDesync`, and `onPoison` only for `BadBatch` ids | A batch the server accepted being treated as rejected |

Together, 2, 3 and 4 are "nothing lost, nothing applied twice": every user
batch landed exactly once, in its client's order, and a fault-free run
reproduces the result. Serial replay is what catches a duplicate delivery
that re-applied under the same batch id, which accounting cannot see.
Conflict copies then follow from the server's semantics, which pkm-svgx
checks.

**Uids.** Each client creates only from its own pool of fresh uids, each
at most once per example, as real random uids would be. An `Edit` can then
never meet a legitimate 400 (a create of a uid another client already
made), so every terminal rejection is a `BadBatch`'s. The model tracks
which pool uids are used.

## The gate

| Piece | Change |
|---|---|
| `server/tooling/proptest/sides.py` | `web` becomes available. A change under `server/src/` now picks the web side too, since this suite drives the server's sync routes as much as the client |
| `server/tooling/proptest/run.py` | A web runner: start `sync_server.py` on 8978, poll `/healthz`, run vitest with `PROPTEST_BASE_URL` (and `PROPTEST_SEED` for `--seed N`), stop the server by PID |
| `web/vitest.props.config.ts` | Node environment, `src/props/**/*.prop.ts`, no coverage, a long test timeout |
| `web/package.json` | `fast-check` devDependency |
| Calibration | `numRuns` sized so the web side runs in about 3 minutes, the way `MERGE_EXAMPLES` was. The suite reports how often each command and fault fired, so a generator that stops reaching a case shows up as a shifted count |
| AGENTS.md | 8978 in the port table |

**A failure prints** fast-check's seed and path, the shrunk command list,
the invariant that failed with a diff of the tables involved, and a
one-line replay command.

## Testing the harness

**Does the oracle have teeth?** Before the property, the suite runs fixed
scenarios with a deliberately broken transport, each of which must make the
property fail. If one passes, the oracle is blind and the gate fails:

| Broken transport | Must trip |
|---|---|
| Drops a batch and fakes a 200 | Accounting |
| Re-posts a batch under a fresh batch id | Accounting |
| Holds one batch and delivers it after the client's next | Per-client order |
| Removes the blocks from one changes window | Convergence |
| Alters a recorded body before the replay | Serial replay |

These need the server, so they live in the props suite. The `createOpQueue`
deps and `clientRuntime` get ordinary unit tests in the normal suite.

## Files

| File | Change |
|---|---|
| `web/src/sync/opQueue.ts` | `OpQueueDeps` |
| `web/src/sync/clientRuntime.ts` (+ test) | New, extracted from `SyncProvider.tsx` |
| `web/src/sync/SyncProvider.tsx` | Adapter over `clientRuntime` |
| `web/src/props/sync/` | Harness client, transport, commands, oracle, self-tests, the property |
| `web/vitest.props.config.ts`, `web/package.json` | Props config, fast-check |
| `server/tooling/proptest/sync_server.py` | New launcher |
| `server/tooling/proptest/run.py`, `sides.py` (+ tests) | Web runner |
| `docs/architecture/property-checks.md` | The web side: modules, running, reading a failure, calibration |
| `docs/architecture/frontend.md` | `clientRuntime` in the module map |
| `docs/architecture/sync-and-offline.md` | The `createOpQueue(replica)` sentence |
| `AGENTS.md` | Port 8978 |

Branch gates: `pnpm verify`; `perf/check.sh frontend` (`web/src` changes);
server pytest, pyrefly and ruff for the launcher and runner;
`proptest/check.sh web` and `proptest/check.sh server`.

## Out of scope

- **Op semantics and conflict copies**: pkm-svgx.
- **The optimistic replica state before a pull** (local-apply divergence):
  pkm-j3ui. A single-client mode of this harness could compare it with the
  server's state after the ack; note that on pkm-j3ui.
- **The WebSocket transport itself** (`ws.py`, `socket.ts`): unit tests.
- **Outline edit commands as the edit source**: pkm-f7zv. This suite uses
  raw ops.
- **Replica open failures and the no-replica mode**: the harness always has
  a replica. A failing local write (`writeFails`) is in scope.
