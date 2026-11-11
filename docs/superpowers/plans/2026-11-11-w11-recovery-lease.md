# W11 Recovery Lease Follows the Snapshot Download: Task-Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Implementers work under the epic's implementer brief; this plan does not restate it.

**Goal:** A recovery whose snapshot download is slower than the 120 s lease no longer fails at commit and re-downloads for ever, and Reset local data can escape it. The worker's recovery lease is renewed by progress (each flushed batch's ack and the snapshot body arriving), the snapshot fetch gets a stall bound, and the snapshot and changes responses are gzip-compressed. The lease's protection against a main thread that stops running survives unchanged in kind: no renewal for `RECOVERY_LEASE_MS`, and the worker frees the gate.

**Architecture:** The lease stays where it is enforced today, a worker timer in `workerHandlers.ts` on a client-sent wall-clock deadline. A new RPC, `renewRecovery(token, expiresAtMs)`, moves that deadline. Like `commitRecovery` and `abortRecovery` it acts on the held lease directly, outside `gate.run`, which the lease itself occupies. `replicaSync.runRecovery` renews only when the run shows progress, at most once per `LEASE_RENEW_EVERY_MS`. `apiFetch` gains a generic stall bound (`stallMs`) and a progress callback (`onProgress`), which `fetchSnapshot` passes. On the server the two sync routes encode their own body, gzip when the client accepts it, in the route's worker thread.

**Tech stack:** TypeScript, vitest (jsdom and node), fast-check, the sync property suites (`proptest/check.sh web --file sync`); Python 3.12, FastAPI, pytest, Hypothesis.

**Source:** `docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md` § W11 with its Global Constraints and Review Focus; the measurement `docs/superpowers/handoffs/2026-11-09-maintainability-review/report-w11-measure.md` (local, gitignored; its numbers are restated here where a task needs them); Arthur's decision of 2026-11-11: option (c) plus compression. Branch `fix/recovery-lease`, read at `8f954fe9` (W10 merged; `fix/reconnect-owed-pull`, bean `pkm-jowv`, not yet merged).

## Global Constraints

The epic's Global Constraints apply unchanged. The ones that bite here:

- Web verification for implementers is the web gates without Playwright: `cd web && pnpm typecheck && pnpm lint && pnpm lint:comments && pnpm check:fcis && pnpm test:coverage && pnpm build` (all with `--config.verify-deps-before-run=false`; never `pnpm add/install/update`, `node_modules` is a symlink). Server: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`.
- `pnpm verify`, `perf/check.sh` and `proptest/check.sh` are the orchestrator's, run serially. The web gate starts the sync server on port 8978 for every web suite, so no implementer runs it.
- Ports: never 8974. Scratch servers on 8975; the simulator's server on 8979; the WebKit pacing proxy (Task 10) on an unowned port such as 8980, which is in no row of the AGENTS.md ports table.
- Property tests (Arthur's standing rule): the lease gains a transition (renewal) and a client-side driver (renew on progress, stall). Task 3 adds a property over the worker lease; Task 7 extends the sync suite so its clients meet slow and stalled downloads. Existing suites stay green; the queue suite's model is unchanged (its recovery stand-in is `memReplica`, whose gate has no clock).
- Tests that the new `Replica.renewRecovery` and the new `ApiFetchOptions` fields break are **ported**: setup changes (a fake gains `renewRecovery`; an assertion on `fetchJson`'s exact options object for the snapshot becomes `objectContaining`), assertions about behaviour do not. An implementer who finds a behavioural assertion failing reports it.
- Comments: no bean ids, line numbers or plan pointers; 80 columns in comments; AGENTS.md's banned word stays out. Docs under `docs/architecture/` go through the `architecture-docs` skill.

## Review Focus

Failure modes no single task's tests are certain to exercise, most likely first.

1. **A gate held for ever.** Renewal must follow progress, never time alone: a renewal on a timer, or on the response headers only, lets a dead connection hold the gate until the OS gives up on it. The stall bound must cover the time to the headers as well as the gaps between chunks. Pinned by Task 4's "no byte at all" test, Task 5's stall test and Task 3's `bounded hold` invariant.
2. **A renewal reviving an expired lease.** Writes that ran in the gap would then sit under a lease the client believes it held throughout. The commit's fingerprint check would still refuse, but renewal must refuse first and the run must stop downloading at once. Pinned by Task 2's "renewal after expiry" test, Task 3's `expired is final`, and Task 5's "a recovery that loses its lease stops downloading".
3. **The client must give up before the worker does.** `SNAPSHOT_STALL_MS + LEASE_RENEW_EVERY_MS < RECOVERY_LEASE_MS`, so a live client abandons a stalled download and releases the gate itself (`abortRecovery`) before the worker's timer fires. Expiry is left for a main thread that stopped running. Pinned by Task 5's constants test.
4. **A stall reported as offline.** `apiFetch`'s catch returns `localFetch` when the offline gateway is installed. A stall abort before the headers would surface as `OfflineError` for `/api/sync/snapshot`, which the shim does not serve. Pinned by Task 4.
5. **A renewal in flight when the commit is sent, or a refused renewal ignored.** The run awaits its last renewal before `commitRecovery`, and a refused renewal aborts the fetch and fails the run with the renewal's error, not the fetch's `AbortError`. Pinned by Task 5.
6. **A renewal meeting a dead worker.** Its `RpcLifecycleError` must end the mode as `no-replica` (W10's rule), never `recovery-failed`. Pinned by Task 5.
7. **Compression applied too widely or in the wrong place.** Only the two sync routes; never a response that carries a credential; the routes stay `def` so encoding runs in the worker thread, not on the event loop. Pinned by Task 1.

---

## Where the repo disagrees

The code wins in each case; the tasks are written to the code.

| The plan, the report or the brief says | The code says | What this plan does |
|---|---|---|
| Report § 7: renew the lease while the fetch makes progress, "or start the deadline at the end of the fetch" | The worker never sees the fetch. The lease is a `setTimeout` in `workerHandlers.ts` `prepareRecovery` on the `expiresAtMs` the client computed (`Date.now() + RECOVERY_TIMEOUT_MS`), and only `commitRecovery` and `abortRecovery` reach a held lease, both outside `gate.run`. A deadline that starts at the end of the fetch leaves the fetch with no worker-side bound at all | A new RPC, `renewRecovery`, outside `gate.run` like commit and abort; the deadline moves only when the run shows progress (§ The lease mechanism) |
| `replicaSync.ts` `UNTIMED`'s doc comment: "A link that is dead rather than slow is still caught -- by noteFailure's backoff for the pull path, and by the recovery entrants' own error handling" | `readTimeoutSignal` returns null for `timeoutMs: null`, so a fetch on a silently dead connection stays pending until the OS gives up on the socket. `noteFailure` never runs, `pullRun` stays in flight and every nudge is owed behind it. During a recovery only the lease frees the gate | The stall bound (Tasks 4, 5) covers every snapshot fetch, the bootstrap's included. `UNTIMED` and its comment go |
| `frontend.md` § API layer: "`/api/sync/snapshot` opts out (`{ timeoutMs: null }`)" | True today | Task 8 rewrites it: untimed, but stall-bounded |
| Epic § W11: "every `enqueue` meanwhile waits behind the gate into its 30 s RPC timeout" | Only an enqueue whose wait passes 30 s times out (`rpc.ts` `createRpcClient.call`, inline `30_000`); past 120 s the worker frees the gate and the queued enqueues persist while the run is still downloading (report § 1) | Context for Question 1: after W11 the gate stays held for the whole download |
| Report § 1: the lease clock "starts at the client's `prepareRecovery` call" | Confirmed: the deadline is computed before the RPC is sent, so the gate wait and the pending-row read count against it | The renewal throttle takes its origin from that call time, not from the lease's arrival |
| `RECOVERY_TIMEOUT_MS` is "the lease" | It is both the lease and the RPC timeout of `prepareRecovery`, `applySnapshot`, `commitRecovery` and `diagnostics` | Split: `RECOVERY_LEASE_MS` (exported, the lease) and `RECOVERY_RPC_TIMEOUT_MS` (module-private, the RPC budget). Both stay 120 s |
| Brief: the token text is shown in the stuck banner and in "Reset failed" | The banner shows `errText(error)` (`problem.error`). "Reset failed:" shows `String(e)` from `session.ts` `resetReplica`, which prefixes the class name: the measured "Reset failed: ReplicaError: invalid or inactive recovery token." | Task 6 (§ The user-facing text) |
| Brief: "the snapshot fetch" | `replicaSync.ts` `fetchSnapshot`, through the `fetchJson` dep, which `SyncProvider` wires to `apiFetch` | The stall bound and progress live in `apiFetch`, where the `Response` is; `fetchSnapshot` passes them |
| `props/sync/transport.ts`: "apiFetch's read deadline is not reproduced" | It reproduces no progress or stall either | Task 7 makes the transport honour `stallMs` and `onProgress` |
| Arthur's rule: a property suite for the changed machine | `checks.md` § Property gate: "A property of one pure module is an ordinary unit test instead (`*.props.test.ts`)". `replica/queueUnreadable.props.test.ts` already drives `buildHandlers` against a model, on every commit | The lease property is `replica/recoveryLease.props.test.ts`, run on every commit (Task 3); its composition with sync runs in the gate's sync suite (Task 7) |
| Brief: "fake timers or an injected clock" | `workerHandlers.test.ts` injects `clockMs` under `vi.useFakeTimers` ("an acquired recovery lease expires if its client forgets the token"). `client.test.ts` runs the real handlers over a `MessageChannel` under fake timers, `Date.now` mocked ("a prepare delayed past its client timeout cannot later orphan the worker lease") | Worker tests follow the first; the composed headline tests follow the second, so `Date.now` (the client's deadline) and the worker's default `clockMs` move together |
| No compression "in `server/src`" (report) | `git grep -i -e gzip -e compress server/src` finds nothing; uvicorn compresses nothing; Tailscale Serve unverified | Task 1 (§ Compression) |
| `pkm.client.api` reads `/api/sync/changes` | Through `httpx2`, which sends `Accept-Encoding: gzip` and decodes the body itself; FastAPI's `TestClient` does the same | No client change. Every existing server test and the perf backend harness now exercise the gzip path |

## The lease mechanism

**Decision: renewal by progress, plus a stall bound on the fetch.** The lease keeps its one rule: the worker frees the gate `RECOVERY_LEASE_MS` after the run's last sign of progress. The client renews when its run advances, never on a clock. A main thread that stops running, a promise chain that lost its token (`client.test.ts`'s orphaned prepare) and a POST that hangs during the flush all stop the renewals, so the gate is freed as it is today. A slow download that keeps arriving keeps the gate. A download that stops arriving is abandoned by the client after `SNAPSHOT_STALL_MS`, and the run releases the gate itself through `abortRecovery`, long before the worker's timer fires.

Rejected alternatives, with the reason:

- **Deadline from the end of the fetch** (the report's second form): the worker would hold the gate unbounded during the fetch, which is where every measured failure sat. Bounding it needs a deadline during the fetch anyway, which is this design.
- **A heartbeat on a timer:** proves the main thread runs, not that the recovery advances. A flush POST that hangs (mutations are never aborted, `readTimeoutSignal`) would heartbeat for ever, and the gate with it.
- **Raising `RECOVERY_LEASE_MS`:** moves the crossover, does not remove it; the report's § 5 shows prod already crossing at about 1.1 Mbit/s uncompressed.

| Phase of `runRecovery` | Lease | Renewed by | Ends |
|---|---|---|---|
| `prepareRecovery` (gate wait, pending-row read) | deadline = the call's `Date.now() + RECOVERY_LEASE_MS` | nothing | the lease is granted |
| flush (`flushLease`) | runs | each leased batch's ack | the last batch |
| `GET /api/sync/snapshot` | runs | the body arriving: each chunk calls `onProgress` | the body ends, or `SNAPSHOT_STALL_MS` with no byte (the headers included) fails the fetch |
| `commitRecovery` | stopped: the worker clears the timer when the commit starts, as today | — | the commit's own end |
| no renewal for `RECOVERY_LEASE_MS` | expired: the worker aborts the gate; queued calls run | — | `renewRecovery`, `commitRecovery` and `abortRecovery` for that token are refused with `LEASE_EXPIRED` |

Renewal rules, all in `runRecovery`:

1. `renewIfDue()` starts a renewal only when none is in flight and `Date.now() - lastRenewalOrigin >= LEASE_RENEW_EVERY_MS`. `lastRenewalOrigin` is `Date.now()` read just before `prepareRecovery` is called, then the time each renewal was sent.
2. A renewal sends `Date.now() + RECOVERY_LEASE_MS`. The worker keeps the later of the held and the sent deadline, so a renewal delivered late never shortens the lease.
3. A refused renewal (expired, unknown token, a timeout, a dead worker) is stored as `leaseLost`, aborts the fetch through an `AbortController` whose signal `fetchSnapshot` passes in `init`, and fails the run with `leaseLost`, never with the fetch's `AbortError`. The flush's `beforePost` checks `leaseLost` too. POSTs are never aborted.
4. Before `commitRecovery` the run awaits the renewal in flight, if any, and throws `leaseLost` if set.
5. Constants: `RECOVERY_LEASE_MS = 120_000` (`replica/client.ts`), `LEASE_RENEW_EVERY_MS = 15_000` and `SNAPSHOT_STALL_MS = 30_000` (`sync/replicaSync.ts`). A unit test holds `SNAPSHOT_STALL_MS + LEASE_RENEW_EVERY_MS < RECOVERY_LEASE_MS`, with the reason in the test name (Question 6).

Worker side, in `workerHandlers.ts` beside `preparedRows`. The fingerprint stays in `preparedRows`; the lease state gains a deadline and the token that last expired:

| Held state | Call | Answer | Next |
|---|---|---|---|
| none, or another token | `renewRecovery(t)` | refused: `LEASE_EXPIRED` if `t` is the token that last expired, else `"invalid or inactive recovery token"` | unchanged |
| held `t`, deadline `d` | `renewRecovery(t, d2)` | ok | deadline `max(d, d2)`; the timer is cleared and re-armed |
| held `t`, commit started | `renewRecovery(t)` | refused, invalid token | unchanged; the commit runs on |
| held `t` | the timer fires with `clockMs() < deadline` (a stale timer) | — | re-armed at the deadline |
| held `t` | the timer fires at or past the deadline | — | `gate.abort(t)`, `preparedRows` cleared, `t` remembered as expired |
| expired `t` | `commitRecovery(t)` or `abortRecovery(t)` | refused, `LEASE_EXPIRED`, checked before `gate.commit`/`gate.abort` | unchanged |

The cost, stated in the docs (Task 8) and put to Arthur (Question 1): an edit typed during the gate span waits behind it. Its enqueue times out after 30 s and joins the in-memory lane, which delivers under the same recovery barrier. Until the gate frees, the edit exists only in memory. Before W11 the 120 s lease capped that span, at the price of failing the recovery; after W11 the span is the whole download. Compression shortens it about 8.6×.

## Compression

**Decision: the two sync routes encode their own bodies, gzip at level 6, only when the client accepts gzip and the body is at least `GZIP_MIN_BYTES` (1024).**

- **Where:** `routes_sync.py`, `sync_snapshot` and `sync_changes`, through one helper, not a middleware. The routes are `def`, so FastAPI runs them in its thread pool; encoding there keeps the 15 MB JSON render and the ~125 ms of gzip CPU (report § 2) off the event loop, which `GZipMiddleware` would block. A global middleware would also reach the assistant's SSE stream, asset responses (PDFs and images, already compressed, served by digest) and the login response; the side channel below argues for keeping compression to responses whose content is only notes.
- **Encodings:** gzip only (stdlib `gzip.compress(body, compresslevel=6, mtime=0)`; `mtime=0` makes the output deterministic for tests). Brotli is 1.24 MB against gzip's 1.76 MB on the fixture but needs a native dependency; zstd is not in the 3.12 stdlib (Question 4).
- **Negotiation:** `accepts_gzip(header: str | None) -> bool` in a new Functional Core module, `server/src/pkm/server/http_encoding.py`: true when an entry `gzip` (or `x-gzip`) has q > 0, or `*` has q > 0 and no entry names gzip with q = 0. An unparseable q drops its entry. It never raises (a Hypothesis test over arbitrary text).
- **Body:** built in memory, as today. The read transaction (`read_txn`) closes before encoding: the payload is built inside it, then serialized and compressed after it, so no read snapshot is held through 125 ms of CPU. Streaming the body would hold the read transaction for the whole send to a slow client and delay WAL checkpoints for minutes; the in-memory body's peak is the JSON plus about 12% for the gzip copy.
- **Serialization:** the helper renders exactly what FastAPI renders for a `response_model` today: `payload.model_dump(mode="json", by_alias=True)` through Starlette's `JSONResponse` rendering (`ensure_ascii=False`, compact separators). The perf backend's exact `bytes` metric for `sync/snapshot` (15,143,025, decoded by `TestClient`) is the byte-identity guard: it must not change.
- **Headers:** `Content-Encoding: gzip` when encoded; `Vary: Accept-Encoding` on both encodings of both routes; `Content-Length` of the wire body (Starlette sets it).
- **The side channel:** a compressed response's length depends on how well its parts compress together (BREACH). Here every body is notes and sync metadata; no cookie, token or key travels in it. An attacker would need a write path into the notes (an approved assistant write, a `pkm-mcp` client, an import), a way to make the device fetch the routes (a sibling tailnet page can make blind same-site GETs, `docs/SECURITY.md` § Authentication), and the sizes of the device's encrypted traffic. Task 8 adds one Known limitations row saying so, and states the rule beside the helper in `backend.md`: a response that carries a credential never goes through it.
- **Slow clients:** `WRITE_STALL_TIMEOUT_S` (`backend.md` § Auth) bounds progress, not total time; a compressed body only leaves sooner. Nothing changes there.
- **What else it covers:** the changes feed, because a full window (1,000 rows at about 299 B each, report § 2) is about 300 KB and `READ_TIMEOUT_MS` (15 s) aborts it below about 160 kbit/s. Other large JSON reads (a 1,200-block page) and the SPA bundle are left to a follow-up bean with their own measurements (Question 5).
- **Production's proxy:** Tailscale Serve fronts port 8974. The implementer finds out what it does without touching that port: `tailscale serve status --json` (read-only configuration: what Serve forwards to and with which handler), and the Tailscale source for Serve's reverse proxy (`ipn/ipnlocal/serve.go`) for any compression handler. Go's `httputil.ReverseProxy` forwards the client's `Accept-Encoding` and the upstream's `Content-Encoding` unchanged, so the expected answer is pass-through: today nothing compresses, and after W11 the server's gzip reaches the device. The design does not depend on the answer. The empirical check belongs to the deploy that follows the merge: the deployer reads the snapshot's response headers through the Serve URL (Question 3 offers a scratch Serve listener before merge instead).

## The user-facing text

**Decision: in this package, for the texts W11's own failure paths produce; a follow-up bean for the rest.** W11 changes when and why a recovery fails. After it, "invalid or inactive recovery token" can reach a user only through a genuine bug (a token the worker never issued). The failures a user can still meet are new or reworded by W11: a stall, and a lease lost because the page stopped running (an iPad app backgrounded mid-download). Their red tests assert their wording, so writing it later would mean asserting text that is then replaced. The broader problem, that both banners print raw internal errors (`request failed: 503 /api/sync/changes`), touches every `SyncProblem`'s copy and belongs to its own bean.

| Failure | Message (the error's own, so the banner and "Reset failed" read the same) | Set in |
|---|---|---|
| no byte for `SNAPSHOT_STALL_MS` | `no data from the server for 30 seconds` (`StalledReadError`, built from `stallMs`) | Task 4 |
| the lease expired before renewal, commit or abort | `the download paused too long to finish the repair` (`LEASE_EXPIRED`, exported from `workerHandlers.ts`) | Task 2 |
| an unknown token | unchanged: `invalid or inactive recovery token` | — |
| "Reset failed:" | the error's message, without its class name (`errText`, not `String(e)`) | Task 6 |

So the stuck banner reads "Local sync is stuck: no data from the server for 30 seconds", and a failed Reset "Reset failed: the download paused too long to finish the repair." (Question 2.)

## Out of scope

| Item | Why |
|---|---|
| Option (b): fetch the snapshot before `prepareRecovery` for `flush: "skip"` entrants | Arthur chose (c). (b) covers only the poison repair and Discard and reset, leaving the preemptible and blocking entrants (report § 6) |
| Letting edits persist during the download | Needs the gate released between the flush and the commit, with a second fingerprint; the fingerprint guard would then refuse every commit while the user types, unless a rebase replays rows enqueued during the fetch. A redesign; Question 1 asks for a bean |
| A banner while a recovery downloads | The report's "the user is told nothing" holds after W11 too, for a shorter time. A UI change; follow-up bean if wanted |
| A bound on the flush's POSTs | Mutations are never aborted (`api/client.ts` `readTimeoutSignal`'s rule). A hung flush POST still hangs the run: renewal stops, so the gate is freed after `RECOVERY_LEASE_MS` as today, but `runRecovery` never settles and `pullRun` stays in flight. Pre-existing; reported under Findings |
| Compression of other routes and the SPA bundle | § Compression; Question 5 |
| The changes feed's `READ_TIMEOUT_MS` on very slow links | Compression moves its floor about 8× lower; a stall bound for the feed would be the same mechanism. Findings |
| The simulator's "Working online only" after an in-tab navigation (report § 9, bug 3) | Not W11, unconfirmed; needs a physical iPad |

## Coordination with `fix/reconnect-owed-pull` (`pkm-jowv`)

`pkm-jowv` changes `ReplicaSync.start()` and `pull()` to resolve a boolean ("a pass served this call") and the reconnect completion's `moved` rule.

| File | `pkm-jowv` touches | W11 touches | Rule |
|---|---|---|---|
| `web/src/sync/replicaSync.ts` | the `ReplicaSync` interface (`start`, `appliedVersion`'s doc), `pullRun`'s comment, `pull`, `doStart`, `startOnce`, `start` | `ReplicaSyncDeps`, the constants, `UNTIMED`, `fetchSnapshot`, `flushBatches`, `flushLease`, `runRecovery` | Tasks 5 and 7 start only after `pkm-jowv` merges to `main` and `main` is merged into `fix/recovery-lease` |
| `web/src/sync/reconnectFlow.ts`, `reconnectFlow.test.ts` | the completion's `served` and `moved` | nothing | — |
| `web/src/props/sync/queueHarness.ts` | the stand-in's `start` returns `true` | nothing (its replica is `memReplica`) | — |
| `web/src/sync/barrier.test.ts`, `clientRuntime.test.ts` | one line each | nothing expected: their replicas are `memReplica` | if a port touches them, after the merge |
| `web/src/sync/replicaSync.test.ts` | nothing | Task 5 | after the merge, because its fakes' `start` shape moves with `pkm-jowv` |

Tasks 1 to 4 and 6 touch none of `pkm-jowv`'s files and run now.

## Tasks

Each task is one commit unless it says otherwise, in its own worktree off `fix/recovery-lease`, merged back with `--no-ff`. "Web gates" and "server gates" mean the lists in Global Constraints.

### Task 1: The sync routes gzip their bodies

**Implementer:** sonnet. **Parallel lane:** server only.

**Files:** new `server/src/pkm/server/http_encoding.py` (`# pattern: Functional Core`); `server/src/pkm/server/routes_sync.py`; new `server/tests/test_http_encoding.py`, `server/tests/test_sync_compression.py`.

- [ ] **Red tests** in `test_sync_compression.py` (the app's `TestClient`, which sends `Accept-Encoding: gzip, deflate` unless a test overrides it):
  - `test_the_snapshot_is_gzip_encoded_when_the_client_accepts_gzip`: `content-encoding: gzip` and `vary` naming `Accept-Encoding`. Red today.
  - `test_a_changes_window_over_the_floor_is_gzip_encoded_and_a_small_one_is_not`.
  - `test_both_encodings_carry_the_same_json` (snapshot and changes; request with `Accept-Encoding: identity`, then gzip; compare `json.loads` of each decoded body).
  - `test_a_client_that_refuses_gzip_gets_a_plain_body` (`identity`, `gzip;q=0`, `*;q=0`, absent header).
  - `test_the_sync_routes_encode_in_a_worker_thread`: `inspect.iscoroutinefunction` is false for `sync_snapshot` and `sync_changes`. It names the reason: an `async def` would move encoding onto the event loop.
- [ ] **Core tests** in `test_http_encoding.py`: a table for `accepts_gzip` (case, whitespace, q values, `x-gzip`, `*`, empty, malformed q) and a Hypothesis test that it never raises on arbitrary text.
- [ ] **Run; expect FAIL.**
- [ ] **Change:** `http_encoding.py`: `GZIP_MIN_BYTES = 1024`, `accepts_gzip`, and `encode_body(body: bytes, accept_encoding: str | None) -> tuple[bytes, dict[str, str]]` (the body and the headers to add, `Vary` always). `routes_sync.py`: both routes take `request: Request`, build their payload inside `read_txn` as now, and after the `with` block return `_encoded_json(request, payload)`, which renders as § Compression says and returns a `Response` with `media_type="application/json"`. `response_model` stays in the decorators, so OpenAPI is unchanged. Route docstrings are not edited.
- [ ] **Regen check:** `cd server && uv run python -m pkm.regen && git diff --exit-code ../web/src/api/`. Expect no diff. If one appears, a signature or docstring leaked into OpenAPI: commit the regenerated files in this task and say so in the commit.
- **Done:** server gates green; the existing sync route tests pass unchanged (they now read gzip through `TestClient`).
- [ ] **Orchestrator:** `proptest/check.sh server` (its `test_no_500_*` properties send input through every route).

### Task 2: The worker renews a recovery lease

**Implementer:** opus (the lease's states, its timer and the gate). **Parallel lane:** replica only; any time.

**Files:** `web/src/replica/workerHandlers.ts`, `client.ts`, `workerHandlers.test.ts`, `client.test.ts`; `web/src/sync/memReplica.ts`, `web/src/sync/session.ts` (the absent replica); every `Replica` fake the compiler names (port only).

- [ ] **Red tests** in `workerHandlers.test.ts`, each with `clockMs` injected under `vi.useFakeTimers`, as "an acquired recovery lease expires if its client forgets the token" does:
  - `a renewed recovery lease holds the gate past its first deadline` (an `enqueue` queued behind it stays pending past the first deadline).
  - `a renewed lease expires a lease-length after its last renewal, and the queued write then runs`.
  - `a renewal after the lease expired is refused as expired and takes nothing back` (`LEASE_EXPIRED`; the queued write has run; a later `enqueue` is not held).
  - `a commit after the lease expired is refused as expired` (red today: the token wording).
  - `an abort after the lease expired is refused as expired`.
  - `a renewal with a token never issued is refused as invalid`.
  - `a renewal carrying an earlier deadline does not shorten the lease`.
  - `a renewal during a commit is refused and the commit completes` (hold the commit through the injectable `applySnapshot` dep).
  - `a stale timer after a renewal does not expire the lease` (the shell clears the old timer; force a stale fire by injecting the timer, or assert through the clock that the lease is still held after the first deadline's tick).
- [ ] **Red test** in `client.test.ts`: `renewRecovery sends a deadline a lease-length from now on the ordinary RPC timeout` (served handler records the payload; `Date.now` mocked).
- [ ] **Run; expect FAIL.**
- [ ] **Change:**
  - `client.ts`: `export const RECOVERY_LEASE_MS = 120_000`; `RECOVERY_RPC_TIMEOUT_MS = 120_000` (module-private) replaces `RECOVERY_TIMEOUT_MS` in the four RPC timeouts; `prepareRecovery` sends `Date.now() + RECOVERY_LEASE_MS`. `Replica.renewRecovery(token: string): Promise<void>` with its doc (moves the lease's deadline; refused once the lease expired or a commit began). `ReplicaRpc.renewRecovery: { payload: { token: string; expiresAtMs: number }; result: null }`.
  - `workerHandlers.ts`: per the worker table in § The lease mechanism. `export const LEASE_EXPIRED = "the download paused too long to finish the repair"`. `preparedRows` gains `deadline`; a `buildHandlers`-local `expiredToken: string | null` records the token the timer last expired. `commitRecovery` and `abortRecovery` check the expired token before calling the gate, so they refuse with `LEASE_EXPIRED` rather than the gate's own `INVALID_TOKEN`. The existing `"recovery preparation expired"` checks in `prepareRecovery` stay.
  - `memReplica.ts`: `renewRecovery: async () => undefined`. `session.ts`: `renewRecovery: absent`.
- [ ] **Port:** each `Replica` fake gains `renewRecovery` (the compiler lists them; `SyncProvider.test.tsx` and `replicaSync.test.ts` hold most). Assertions do not change. `replicaSync.test.ts` is edited only if its typed fakes fail to compile without the method; if so, that edit waits for the `pkm-jowv` merge or is kept to the added line.
- **Done:** web gates green; "a prepare delayed past its client timeout cannot later orphan the worker lease" and "an acquired recovery lease expires if its client forgets the token" pass unchanged.

### Task 3: A property over the worker lease

**Implementer:** opus (the model and its reach). After Task 2.

**Files:** new `web/src/replica/recoveryLease.props.test.ts`.

The style is `replica/queueUnreadable.props.test.ts`: `buildHandlers` over `openRawTestDb`, `clockMs` injected, `vi.useFakeTimers`, a drawn command list, a model written from § The lease mechanism (the sentences Task 8 puts in `sync-recovery.md` § runRecovery; Task 8 must state them as the model reads them), a tally whose labels must each be reached.

- **Commands:** `prepare` (when no lease is held); `renew` (the held token, the last expired one, or one never issued; deadline later or earlier than the held one); `advance` (a drawn number of ms, up to twice the lease; fires the timers due); `commit` (reset or rebase, optionally held open through the `applySnapshot` dep and released by a later `release` command); `abort`; `enqueue` and `pendingCount` (gated work, queued while the gate is held).
- **Invariants**, in the file's header:
  - `exclusion`: no gated call settles while the model holds the lease or a commit runs.
  - `bounded hold`: once the clock passes the model's deadline with no commit started, every queued gated call settles.
  - `progress holds`: a lease renewed at time `t` is still held at every moment before `t + lease`.
  - `expired is final`: after expiry, renew, commit and abort for that token are refused with `LEASE_EXPIRED`, and the gate is not taken back.
  - `commit completes`: a commit begun before the deadline finishes; the timer never aborts it.
  - `no wedge`: once nothing is held, a gated call succeeds.
- **Labels**, each asserted reached at least once: `renewed past the first deadline`, `out-of-order renewal`, `stale timer fire`, `renew refused: expired`, `commit refused: expired`, `abort refused: expired`, `renew refused: committing`, `gated call released by expiry`, `gated call released by commit`, `timer due during a commit`.
- **Teeth**, uncommitted mutants applied to `workerHandlers.ts`, each run with three seeds and reverted; record which invariant fired in the commit message:

  | Mutant | Expected |
  |---|---|
  | a renewal of the expired token re-takes the gate | `expired is final` |
  | a renewal does not move the timer | `progress holds` |
  | a renewal sets the sent deadline even when earlier | `progress holds` |
  | the commit leaves the timer armed | `commit completes` |
  | expiry forgets the token | `expired is final` (the wording) |

- **Done:** web gates green, the property's run time noted in the commit (it runs on every commit; the orchestrator judges whether its `numRuns` suits that).

### Task 4: `apiFetch` bounds a read by its silence

**Implementer:** sonnet. **Parallel lane:** `web/src/api/` only; any time.

**Files:** `web/src/api/client.ts`; new `web/src/api/client.stall.test.ts` (`// @vitest-environment node` if jsdom lacks `ReadableStream` or `TransformStream`).

- [ ] **Red tests** (`vi.stubGlobal("fetch", …)` returning a `Response` over a `ReadableStream` the test feeds; fake timers):
  - `a read given stallMs fails with StalledReadError when no byte arrives for stallMs` (no headers at all).
  - `each chunk restarts the stall clock, so a body slower than stallMs in total completes`.
  - `a body that goes silent part-way fails with StalledReadError`.
  - `onProgress runs once per chunk received`.
  - `a stall before the headers stays a StalledReadError with the offline gateway installed` (not `OfflineError`).
  - `a caller's own signal still aborts a stall-bounded read` (guard).
  - `StalledReadError's message names the silence in seconds` (`no data from the server for 30 seconds` at 30,000 ms).
- [ ] **Run; expect FAIL.**
- [ ] **Change:** `ApiFetchOptions` gains `stallMs?: number` (abandon the read when no byte of it, headers included, arrives for this long) and `onProgress?: () => void` (once per body chunk). `export class StalledReadError extends Error` (not an `ApiError`: a stall is the link's, so `isStallShaped` does not count it, like a `TypeError`). With either option set, `apiFetch` makes its own `AbortController`, merged with the caller's signal and any read timeout through `AbortSignal.any`; a timer armed before `fetch` and re-armed on each chunk aborts it. The body is read through `res.body.pipeThrough(new TransformStream(…))`, whose `transform` re-arms the timer and calls `onProgress`, then parsed with `new Response(counted).json()`. A `null` body falls back to `res.json()`. The timer is cleared on every exit. The catch around `fetch` rethrows the `StalledReadError` when the stall timer fired, instead of falling back to `localFetch`. Never rely on `fetch` rejecting with `signal.reason`: record that the stall fired in a local and throw the error from it.
- **Done:** web gates green; the existing `api/client` tests unchanged.

### Task 5: `runRecovery` renews on progress and abandons a stalled download

**Implementer:** opus. **After** Tasks 2 and 4, and after `pkm-jowv` merges (§ Coordination).

**Files:** `web/src/sync/replicaSync.ts`, `replicaSync.test.ts`; new `web/src/sync/recoveryLease.test.ts` (the composed tests).

- [ ] **Red tests**, composed, in `recoveryLease.test.ts`: the real `createReplica` over a `MessageChannel` to the real `buildHandlers` (as in `client.test.ts`), the real `createReplicaSync`, and a `fetchJson` fake that honours the `ApiFetchOptions` contract (Task 4): it calls `opts.onProgress` as it "receives", rejects with `StalledReadError` after `opts.stallMs` of silence, and rejects when `init.signal` aborts. Fake timers throughout, `Date.now` mocked.
  - `a Reset whose snapshot download outlasts the lease commits while the download keeps making progress`. The fake reports progress every 10 s for 300 s, then resolves. `resetLocalData({ discardPending: false })` resolves and the mode is ready. Red today: rejects with "invalid or inactive recovery token" (the report's § 9 bug 1, Reset half).
  - `a rebase whose download outlasts the lease commits once and fetches the snapshot once`. A pull meets needs-bootstrap through a `generation` mismatch in the changes window; advance past the commit and past the first retry the backoff would arm. Snapshot fetches: 1. Red today: 2 or more (bug 1, loop half).
  - `a recovery whose download goes silent fails at the stall and gives the gate back at once`. After `SNAPSHOT_STALL_MS` the run has failed with the stall message, and an `enqueue` resolves well before `RECOVERY_LEASE_MS`. Red today: still pending.
  - `a recovery that loses its lease stops downloading and fails as expired`. The fake ignores `stallMs` (a page that stopped running), its progress pauses past `RECOVERY_LEASE_MS`, then resumes. The renewal is refused, `init.signal` is aborted before the fake's remaining 100 s, and the run fails with `LEASE_EXPIRED`.
  - `a bootstrap's snapshot fetch is stall-bounded` (guard: `opts.stallMs === SNAPSHOT_STALL_MS`, no `onProgress`).
- [ ] **Red tests** in `replicaSync.test.ts` (fake replica recording calls):
  - `the flush renews the lease after an ack once a renewal is due` (leased batches whose POSTs take 20 s each).
  - `renewals start at most once per renewal interval and never two at once` (a held renewal; chunks keep arriving).
  - `the commit waits for the renewal in flight` (record order: `renewRecovery` settles before `commitRecovery` is called).
  - `a renewal that meets a dead worker ends the mode as no-replica` (rejects with `RpcLifecycleError("worker-error")`; states end `no-replica`, never `recovery-failed`).
  - `a live client abandons a stalled download before the worker's lease expires` (`SNAPSHOT_STALL_MS + LEASE_RENEW_EVERY_MS < RECOVERY_LEASE_MS`).
- [ ] **Run; expect FAIL.**
- [ ] **Change:** `replicaSync.ts`: `export const LEASE_RENEW_EVERY_MS = 15_000`, `export const SNAPSHOT_STALL_MS = 30_000`; `UNTIMED` and its comment go. `fetchSnapshot(pending, watch?: { onProgress: () => void; signal: AbortSignal })` passes `{ timeoutMs: null, stallMs: SNAPSHOT_STALL_MS, onProgress }` and `{ signal }` as `init`. `runRecovery` keeps, per run, `lastRenewalOrigin`, `renewing: Promise<void> | null`, `leaseLost: unknown` and an `AbortController`, implementing § The lease mechanism's renewal rules 1 to 4; `flushLease`/`flushBatches` take a `renewIfDue` called after each ack, and every policy's `beforePost` throws `leaseLost` when set. The catch's ordering is unchanged: `abortRecovery` (whose `LEASE_EXPIRED` refusal is swallowed, as the token error is now), `noteIfSessionFatal`, the report.
- [ ] **Port:** `replicaSync.test.ts` assertions on the snapshot `fetchJson` call's third argument become `expect.objectContaining({ timeoutMs: null })`; nothing else.
- **Done:** web gates green.
- [ ] **Orchestrator:** `proptest/check.sh web --file sync` (no model change yet: recoveries in the suite are fast, so no renewal is due; every existing floor must hold).

### Task 6: "Reset failed" shows the message, not the class

**Implementer:** sonnet. **Parallel lane:** after Task 2 (shares `session.ts`); parallel with Task 5.

**Files:** `web/src/sync/session.ts`, `session.test.ts`.

- [ ] **Red test:** `session.test.ts` `a failed reset shows the error's message without its class name` (`resetLocalData` rejects with `new ReplicaError(LEASE_EXPIRED)`; the problem's `resetError` is exactly `LEASE_EXPIRED`). Red today: `"ReplicaError: …"`.
- [ ] **Run; expect FAIL.**
- [ ] **Change:** `resetReplica`'s `reset-failed` fold takes `e instanceof Error ? e.message : String(e)` (the shape `clientRuntime.ts` and `replicaSync.ts` already use; if a shared helper exists in `sync/`, use it).
- **Done:** web gates green; `OfflineIndicator` tests unchanged.

### Task 7: The sync suite meets slow and stalled downloads

**Implementer:** opus (harness judgement, reach and teeth). After Task 5.

**Files:** `web/src/replica/client.ts` (a harness seam), `web/src/sync/replicaSync.ts` (a harness seam); `web/src/props/sync/transport.ts`, `commands.ts`, `harnessClient.ts`, `oracle.ts`, `sync.prop.ts`, `teeth.prop.ts`.

- **Seams**, for the harness only, as `retryBaseMs` is: `createReplica(port, terminate?, opts?: { leaseMs?: number })` and `ReplicaSyncDeps.recoveryTiming?: { renewEveryMs: number; stallMs: number }`. The app passes neither. The harness uses a lease of a few hundred ms with the same inequality as the real constants (assert it in `harnessClient.ts`).
- **Transport:** honours `opts.onProgress` (called once when an answer's body arrives, so `fetchJson`'s contract holds) and `opts.stallMs` (an answer held silent past it rejects with `StalledReadError`, as `apiFetch` would). Two new one-shot faults in `Fault`: `slowSnapshot` (the next snapshot answer is delivered in pieces, `onProgress` per piece, over about three lease-lengths) and `stalledSnapshot` (the next snapshot answer goes silent past `stallMs`, then the transport answers nothing more for that request). One new `Broken` mode for teeth: `starveProgress` (a `slowSnapshot` whose pieces never call `onProgress`).
- **Oracle:** a new check, `leaseHeld`: no recovery in a life whose worker did not die and which was not reloaded during the run had a renewal, commit or abort refused with `LEASE_EXPIRED`. `harnessClient.ts`'s `sessionReplica` records those refusals (wrapping `renewRecovery`, `commitRecovery`, `abortRecovery`) with the life's state at the time. The header gains the check.
- **Labels** (`sync.prop.ts`'s tally): `Fault slowSnapshot`, `Fault slowSnapshot fired`, `Fault stalledSnapshot`, `Fault stalledSnapshot fired`, `Recovery renewed`, `Recovery abandoned on a stall`. Floors by `reach.ts`'s recipe (register with `{}`, `PROPTEST_REACH_LOG`, unseeded runs on a quiet machine, the orchestrator's call).
- **Teeth:** committed: `starveProgress` must fire `leaseHeld`. Uncommitted mutants, two seeds each with `proptest/check.sh web --file sync --seed <n>`, reverted:

  | Mutant | Expected |
  |---|---|
  | `renewRecovery` in the worker answers ok and moves nothing | `leaseHeld` |
  | `runRecovery` never calls `renewIfDue` | `leaseHeld` |
  | `runRecovery` ignores a refused renewal and commits | `leaseHeld` (the commit is refused) |
  | `commitRecovery` skips the fingerprint check | survives unless a stall lets an edit persist mid-run and a reset follows; a survival is a reach fact, carried to the W19 table |

- **Time:** each drawn slow fault adds about three harness lease-lengths to its example. The orchestrator compares the suite's examples-per-second with the baseline and reports it as a fact; no budget or example count changes in this branch, and no floor is lowered to pass.
- **Done:** web gates green.
- [ ] **Orchestrator:** `proptest/check.sh web --file sync`; the reach run for the new floors; the mutants above.

### Task 8: Docs say what W11 made true

**Implementer:** sonnet (`architecture-docs` skill), reviewed by the strongest model for the security sentence. After Task 7.

**Files:** `docs/architecture/sync-recovery.md`, `frontend.md`, `backend.md`, `docs/SECURITY.md`; the epic plan's W19 table only if a Task 7 mutant survived.

- `sync-recovery.md` § runRecovery: the flowchart shows the gate span and the deadline, and a table gives the lease by phase (§ The lease mechanism's first table, in the doc's words). The sentences Task 3's model reads: the gate is freed `RECOVERY_LEASE_MS` after the run's last sign of progress; progress is a leased batch's ack or a chunk of the snapshot body, at most one renewal per `LEASE_RENEW_EVERY_MS`; the commit is not under the lease; expiry aborts the gate, and renewal, commit and abort for that token are then refused as expired; a renewal never shortens the deadline. The rule with its reason: `SNAPSHOT_STALL_MS + LEASE_RENEW_EVERY_MS < RECOVERY_LEASE_MS`, so a live client abandons a stalled download and releases the gate itself, and expiry is left for a page that stopped running. The cost: edits made during the gate span wait in memory until it frees. A starting sketch, to be fitted to the doc by the skill:

  ```mermaid
  flowchart TD
      P["queue.pause('recovery')"] --> AW{"awaitInFlightPull?"}
      AW -->|yes| WP["await the start and the pull in flight"] --> L
      AW -->|no| L
      subgraph G["worker gate held: every other replica call waits"]
          L["prepareRecovery()<br/>deadline: call time + RECOVERY_LEASE_MS"] --> F["flushLease<br/>each ack renews, if due"]
          F --> S["GET /api/sync/snapshot<br/>each chunk renews, if due<br/>SNAPSHOT_STALL_MS of silence fails it"]
          S --> C{"commitRecovery<br/>lease live, rows unchanged?<br/>timer stopped"}
          C -->|"yes, reset"| RB["rebuildOrReplaceFile"]
          C -->|"yes, rebase"| RS["rebaseOrReplaceFile"]
      end
      X["no renewal for RECOVERY_LEASE_MS:<br/>gate aborted; renew, commit, abort<br/>refused as expired"] -.-> G
      RB --> OK["adoptCursor(snapshot.seq)"]
      RS --> OK
      C -.->|no| AB["abortRecovery(token), rethrow"]
      F -.->|throws| AB
      S -.->|"throws, or renewal refused"| AB
      OK --> R["finally: queue.resume('recovery')"]
      AB --> R
  ```

- `sync-recovery.md` § Failure modes at a glance: one row, "A snapshot download slower than the lease, or one that stops": renewed by progress; abandoned after `SNAPSHOT_STALL_MS`; link to § runRecovery. § Recovery never erases intent: no new guard, but the gate row says the lease bounds it by progress.
- `frontend.md` § API layer: the snapshot is untimed but bounded by `stallMs`; `onProgress` names its one caller.
- `backend.md` § HTTP API reference: the snapshot and changes rows say "gzip when the client accepts it". One paragraph where the table's preamble is: the two sync routes encode their own body (`http_encoding.py`), in the route's worker thread and after the read transaction closes; a response that carries a credential never goes through it; why not a middleware (event loop, SSE, assets).
- `docs/SECURITY.md` § Known limitations: one row for the compression length side channel, per § Compression.
- **Done:** `node .claude/skills/architecture-docs/check-docs.mjs` passes; the commit says what was corrected and what was added.

### Task 9: The troubleshooting row

**Implementer:** sonnet. **Last commit on the branch, touching only `docs/troubleshooting.md`** (another branch is restructuring it, so the row must merge as one isolated hunk).

- One row under Sync and offline. Symptom: on a slow link (below about 1 Mbit/s for a prod-sized graph) no banner for minutes, then "Local sync is stuck: invalid or inactive recovery token", the snapshot downloading again without end, and Reset local data failing with "Reset failed: ReplicaError: invalid or inactive recovery token." Cause: the worker's recovery lease was a fixed 120 s from `prepareRecovery`, and the snapshot download inside it was untimed and uncompressed; now renewed by progress (`renewRecovery`), stall-bounded, gzip. Where: [sync-recovery.md § runRecovery](architecture/sync-recovery.md#runrecovery). Ref: `pkm-3iwm`, `recoveryLease.test.ts`.

### Task 10: Measure the fix

**Implementer:** opus. After Tasks 1 to 7 are merged into `fix/recovery-lease`. Scratch scripts and logs stay in the scratchpad; temporary instrumentation is reverted and `web/dist` rebuilt clean, as the report did. Servers started are stopped by PID.

**Chromium, the report's method** (§ 3): headless Chromium through Playwright, CDP `Network.emulateNetworkConditions`, `server/tests/e2e_serve.py` on 8975 with `E2E_FROM_DB` set to a copy of the perf fixture and `PKM_ROW_CHECK=0`, the rebase triggered by `UPDATE sync_meta SET value=lower(hex(randomblob(16))) WHERE key='db_generation'` on the scratch copy plus one POSTed op. Reuse the report's driver if its scratch copy survives, else rebuild it from § 3. Rows that must flip, against the report's § 3 and § 4 tables:

| Profile | Entrant | Report | Must now be |
|---|---|---|---|
| 1.0 Mbit/s / 500 kbit/s, 300 ms | rebase | commit refused at 121.6 s | commits; fetch about 14 s |
| 400 kbit/s | rebase | commit refused, loops | commits once; one snapshot fetch; fetch about 35 s |
| 400 kbit/s | Reset local data | "Reset failed: … invalid or inactive recovery token." | succeeds |
| 400 kbit/s, `Network.setAcceptedEncodings` with an empty list (no gzip) | rebase | (the report's bug 1 profile) | commits after about 303 s, by renewal alone; renewals logged |
| 100 kbit/s (new row) | rebase | not run; about 1,210 s computed | commits after about 141 s: past the old lease even compressed, so only renewal explains it |
| Fast 3G | rebase, Reset, poison repair | fetch 84.7 s; enqueue waits 30 s, 30 s, 25.8 s | fetch about 10 s; no enqueue timeout |
| 400 kbit/s, edits typed during the run | rebase | 3 timeouts, lane, banner at 303 s | the first enqueue may still time out (gate span about 39 s); delivered; no banner |
| Throughput cut to zero mid-download (new row) | rebase | — | fails `SNAPSHOT_STALL_MS` after the last byte with "no data from the server for 30 seconds"; an enqueue resolves before the lease would have expired; the retry commits once the link returns |

Also record, unthrottled: `encodedBodySize` against `decodedBodySize` for the snapshot (expect about 1.8 MB against 15.1 MB) and the commit times, which should not move.

**WebKit, with the `ipad-simulator` skill** (`simpad.py`, server on 8979 with `E2E_FROM_DB`). Network Link Conditioner throttles the whole machine, production included, so it stays off. Instead, a pacing TCP proxy in the scratchpad (asyncio, a few dozen lines) listens on an unowned port such as 8980, forwards to 8979, and paces only the server-to-client direction. The simulator opens the proxy's URL. The server must accept the proxy's origin, or the origin guard refuses the WebSocket and every write: add an `E2E_SERVE_ORIGINS` environment variable to `server/tests/e2e_serve.py` that fills `Config.serve_origins` (documented in its docstring beside the others), in its own tooling commit.

| Check | Expect |
|---|---|
| Unthrottled cold bootstrap | `pkm:replica-ready`; the snapshot's Resource Timing `encodedBodySize` well under `decodedBodySize`: WebKit decodes gzip and the streamed parse works |
| Unthrottled rebase (generation rotation) | commits; an edit typed during it reaches the server |
| Through the proxy at about 400 kbit/s, rebase | commits; renewals observed (a temporary `console.info`, reverted); no stuck banner |
| Through the proxy, forwarding paused mid-body | the stall text after about 30 s; resuming lets the retry commit |
| Optional: the simulator app sent to the background mid-download through the proxy, and brought back after more than `RECOVERY_LEASE_MS` | either the run commits, or it fails with `LEASE_EXPIRED` and the retry commits; record which. This is the expiry path a real iPad meets |

- **Done:** a results table in the handoff directory (`docs/superpowers/handoffs/`, gitignored) with every row above, the setup, and the limits of the method as the report's § 8 states them; the bean's summary cites it. Only the `e2e_serve.py` commit lands on the branch.

## Order and parallel lanes

```
T1 (server) ─────────────────────────────────────────────┐
T2 -> T3                                                  │
T2 -> T6                                                  ├-> T10 -> T8 -> T9
T4 ───────┐                                               │
T2, T4, pkm-jowv merged -> T5 -> T7 ─────────────────────┘
```

| File | Tasks | Rule |
|---|---|---|
| `server/src/pkm/server/routes_sync.py`, `http_encoding.py` | T1 | parallel lane |
| `web/src/replica/workerHandlers.ts`, `replica/client.ts` | T2, T7 (`client.ts` seam) | serial |
| `web/src/replica/recoveryLease.props.test.ts` | T3 | after T2 |
| `web/src/api/client.ts` | T4 | parallel lane |
| `web/src/sync/session.ts` | T2 (absent replica), T6 | serial |
| `web/src/sync/replicaSync.ts`, `replicaSync.test.ts` | T5, T7 (seam) | serial, after `pkm-jowv` |
| `web/src/props/sync/*` | T7 | after T5 |
| `server/tests/e2e_serve.py` | T10 | its own tooling commit |
| docs | T8, then T9 alone | implementers leave prose to T8 and say in their commit what became true |

## Property gate

1. **Baseline** after Task 5 merges: `proptest/check.sh web --file sync`. Keep both suites' tallies. Every existing floor must pass: a fast recovery never reaches a renewal, so W11 changes nothing a current label counts.
2. **The lease property** (Task 3) runs on every commit inside `pnpm test:coverage`; its reach is its labels' asserts, its teeth the Task 3 mutants.
3. **The sync suite** (Task 7): the transport's progress and stall, two faults, one `Broken` mode, one oracle check. The model it checks against is `sync-recovery.md` § runRecovery after Task 8; a check that fails is judged against the docs first, never edited to match new code.
4. **Mutants** as in Tasks 3 and 7. A surviving mutant is a fact about reach, reported with the table and carried to the W19 table below.
5. **Floors:** none changes without re-measurement by `reach.ts`'s recipe on a quiet machine, and none is lowered to pass. A floor that fails is first a question: does its label's path depend on W11? If not, it is a finding.
6. **Fault warnings:** a `StalledReadError` in the sync suite's `fault warnings` line is expected only under `stalledSnapshot`; add the kind to `EXPECTED_KINDS` with that reason. Anything else `UNEXPECTED` is a finding.
7. **Final:** `proptest/check.sh web` (the whole side) and `proptest/check.sh server`.

## Perf

| Check | Expected | If not |
|---|---|---|
| `perf/check.sh backend`, `sync/snapshot` | `bytes` unchanged at 15,143,025 (`TestClient` decodes; a change means the render differs from FastAPI's); counts unchanged; `median_ms` up by the gzip CPU, about 125 ms on 375 ms, under the gate's `TIMING_FACTOR` | a changed `bytes` is a finding in Task 1's render, not a re-record |
| `perf/check.sh backend`, `sync/changes-mid` | counts unchanged; timing within noise | — |
| `perf/check.sh frontend`, `H/cold` | `api_bytes` falls from about 15.16 MB to about 1.8 MB: an improvement the check folds into the baseline, committed with the branch; `snapshot_requests` and `requests` unchanged; `replica_ready_ms` about the same on loopback | — |
| any regression | read the diff along the regressed path first (AGENTS.md § Testing) | if Arthur accepts it, `perf/check.sh <side> --bootstrap` with the reason in the commit message |

Both sides run serially on a quiet machine, on the final branch, before merge.

## Traps

- **`fetch` and `signal.reason`.** Whether `fetch` rejects with the abort reason varies by engine version. Record the cause (stall, refused renewal) in a local and throw it; treat the `AbortError` as a carrier.
- **The gateway fallback.** `apiFetch`'s catch around `fetch` returns `localFetch` when a gateway is installed; a stall before the headers must not take that path (Task 4).
- **jsdom streams.** `ReadableStream` and `TransformStream` may be missing or partial in vitest's jsdom; the stall tests run in the node environment.
- **Fake timers and `MessageChannel`.** The composed tests follow `client.test.ts`: `vi.useFakeTimers()` mocks `Date` too, so the client's deadline and the worker's default `clockMs` agree; drive time with `advanceTimersByTimeAsync`, which lets channel messages through between timers.
- **A renewal's own timeout.** `renewRecovery` uses the ordinary RPC timeout; a timeout is a refused renewal, not a reason to keep downloading.
- **The read transaction.** Encoding inside `read_txn` would hold a read snapshot through the gzip; build the payload inside, encode after.
- **Excess-property errors on fakes.** Typed `Replica` fakes fail to compile once `renewRecovery` is required. That is the port, setup only.
- **Brand rules, FCIS, comment lint.** `http_encoding.py` is Functional Core (gzip is pure computation); the routes stay Imperative Shell. Detect: `pnpm lint`, `pnpm check:fcis`, `pnpm lint:comments`, the server's commentlint sweep inside `pytest`.

## Final gates

| Gate | Who |
|---|---|
| Server gates, web gates without Playwright | each implementer, per task |
| `uv run python -m pkm.regen` with no diff under `web/src/api/` | Task 1's implementer; again by the orchestrator on the final branch, since `pkm-jowv` merges in between |
| `proptest/check.sh server` | orchestrator, after Task 1 and on the final branch |
| `proptest/check.sh web --file sync`, steps 1, 3 and 4 above | orchestrator, serially, after Tasks 5 and 7 |
| `pnpm verify` including the full Playwright suite | orchestrator, on the final branch |
| `proptest/check.sh web` (whole side) | orchestrator, serially, on the final branch |
| `perf/check.sh backend`, then `perf/check.sh frontend` | orchestrator, serially, quiet machine, final branch, before merge |
| Task 10's tables | before the final review; the review package includes them and the perf table |

## W19 additions

Rows only if Task 7's mutants survive:

| Machine | Converted in | Suite |
|---|---|---|
| The recovery lease under expiry with edits persisting mid-run (the fingerprint guard) | W11 | extend `props/sync/` to draw an expiry: a page that stops running mid-download, which the harness can stand in for by suspending a life's renewals while its worker keeps running. Guarded by `workerHandlers.test.ts` ("commit refuses changed durable rows and releases the recovery lease") and Task 3's property |

## Findings

**A. A dead link hangs the bootstrap today.** `UNTIMED` gives the snapshot fetch no bound, so a silently dead connection keeps `pullRun` (or `startOnce`) in flight until the OS gives up, and every nudge is owed behind it. Fixed by Task 5 for every snapshot fetch.

**B. A hung flush POST hangs the run.** The recovery flush posts through `deliverLeased`; mutations are never aborted. The lease frees the gate after `RECOVERY_LEASE_MS` (with or without W11), but `runRecovery` never settles and `pullRun` stays in flight. Not fixed here; a bean if wanted.

**C. The changes feed on very slow links.** A full window (about 300 KB) cannot arrive within `READ_TIMEOUT_MS` below about 160 kbit/s, so such a link's catch-up pull fails for ever. Gzip moves that to about 20 kbit/s. Not fixed here.

**D. Read timeouts become `OfflineError`.** For any route the shim does not serve, a read timeout while the gateway is installed surfaces as `OfflineError`, not as a timeout. `isStallShaped` excludes both, so nothing miscounts, but a log reads "offline" for a slow server. Task 4 exempts the stall only.

## Questions for Arthur

1. **Edits during a long recovery live in memory for the whole download.** Before W11 the 120 s lease capped that, by failing the recovery; after it, the gate stays held until the download ends (about 10 s on Fast 3G and 35 s at 400 kbit/s once compressed; 141 s at 100 kbit/s). An iOS home-screen app honours no `beforeunload`, so closing it in that window loses those edits. Recommendation and default: accept, and file a bean for letting edits persist during the download (§ Out of scope).
2. **The wording.** "no data from the server for 30 seconds" for a stall; "the download paused too long to finish the repair" for an expired lease; "Reset failed:" without the class name. Default: as written; a copy pass over every sync banner is a follow-up bean.
3. **Tailscale Serve before merge.** A scratch Serve listener on another HTTPS port (`tailscale serve --bg --https=<port> http://127.0.0.1:8975`, removed afterwards) would show Serve's handling of `Content-Encoding` before the merge. It changes the tailnet node's Serve configuration and briefly exposes a scratch server to the tailnet. Default: no; the deploy checks the headers through the real Serve URL.
4. **gzip only.** Brotli would save about another 30% (1.24 against 1.76 MB) for a native dependency. Default: gzip.
5. **Compression stays on the two sync routes.** Default: yes; a follow-up bean measures the SPA bundle and the large page reads before deciding a wider scheme.
6. **The numbers.** `RECOVERY_LEASE_MS` 120 s (unchanged), `LEASE_RENEW_EVERY_MS` 15 s, `SNAPSHOT_STALL_MS` 30 s. A stall shorter than 30 s fails healthy links whose server answer is slow to start (the fixture's snapshot takes about 0.4 s on loopback; prod under load is unmeasured). Default: these.
7. **Harness seams.** `createReplica`'s `leaseMs` option and `ReplicaSyncDeps.recoveryTiming` exist only so the sync suite can scale time, as `retryBaseMs` does. Default: accept.
