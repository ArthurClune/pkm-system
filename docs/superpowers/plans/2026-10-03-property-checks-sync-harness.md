# Sync protocol harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `proptest/check.sh web` runs a fast-check model-based suite that drives the real web sync stack against a real server under injected faults and checks convergence, delivery accounting, per-client order and a fault-free serial replay.

**Architecture:** Two small product changes make the stack drivable from Node: optional deps on `createOpQueue`, and the startup/poison-repair sequence extracted from `SyncProvider` into `sync/clientRuntime.ts`. A test-only Python launcher serves the real app on 8978 with reset/clock/generation/applied routes. The harness (`web/src/props/sync/`) builds 2–3 clients from real sqlite-wasm + worker handlers + queue + replicaSync + runtime + reconnectFlow, each with a faulty transport, and `proptest/run.py` gains a web runner.

**Tech Stack:** TypeScript, vitest 3 (Node environment), fast-check, `@sqlite.org/sqlite-wasm`; Python 3, FastAPI, uvicorn, `time_machine`, pytest.

**Spec:** `docs/superpowers/specs/2026-10-03-property-checks-sync-harness-design.md`

## Global Constraints

- Port **8978** for the harness server. Never bind 8974 (production); 8975 is scratch/E2E, 8977 is perf.
- The props suite never runs from `pnpm test:unit`, `pnpm test:coverage` or `pnpm verify`: files are `*.prop.ts` under `web/src/props/`, picked up only by `web/vitest.props.config.ts`.
- `/__proptest/*` routes exist only in `server/tooling/proptest/sync_server.py`, never in `pkm.server.app.create_app`.
- `createOpQueue(replica)` with no deps, and `SyncProvider`, behave exactly as today. `SyncProvider.test.tsx` passes **unmodified**.
- Every new web/server file with runtime behaviour carries `// pattern: Functional Core` / `Imperative Shell` (or `#`) near the top; `pnpm check:fcis` enforces it on web.
- Comments carry no bean ids. No phrase "load-bearing" anywhere.
- Long commands (property runs, perf, timing) run in the **foreground** with Bash timeout 600000 — never Monitor or a background wait.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and **no** `Claude-Session:` trailer (`.githooks/commit-msg` rejects it).
- Web-side budget: about 3 minutes for `proptest/check.sh web`.
- Stop any server you start by PID, never `pkill -f`.

## Review Focus

1. **A reload while a POST is in flight.** A reload that disposes the queue mid-delivery must not lose or double the batch; the `Reload` command must be able to land while background drains run (it awaits nothing but persistence). Pinned in Task 7's fixed-scenario test `reload during in-flight post`.
2. **A `dropAck` on the recovery flush's POST** (not the queue's). `replicaSync.flushBatches` posts through `fetchJson`, so the transport's fault queue must apply to both doors. Pinned in Task 5's transport test `dropAck applies to fetchJson posts too`.
3. **The server clock frozen across the whole run.** Session cookies, login throttling and anything else reading `time.time()` see a still clock; a reset must not log the harness out. Pinned in Task 3's `test_session_survives_reset_and_clock_moves`.
4. **Quiescence never reached** (a wedged queue, a backoff growing to 60 s). The quiesce loop must fail with a readable liveness message within its limit rather than time the vitest test out silently. Pinned in Task 6's `quiesce reports liveness failure`.
5. **A `Nudge` with a future seq** (ahead of the journal) must not move the cursor past the server's `latest_seq`. Covered by the cursor invariant and Task 7's fixed scenario `future nudge`.

---

### Task 1: `createOpQueue` deps

**Files:**
- Modify: `web/src/sync/opQueue.ts` (`postOps` at ~145, `createOpQueue` at ~151, batch id at ~651, poison store calls at ~152/348/377/761)
- Test: `web/src/sync/opQueue.deps.test.ts` (new, `// @vitest-environment node`)

**Interfaces:**
- Produces:
  ```ts
  export interface PoisonIntentStore {
    read(): PoisonEvent[];
    write(intents: readonly PoisonEvent[]): void;
  }
  export interface OpQueueDeps {
    post?: (body: OpBatch) => Promise<OpsAck>;   // OpBatch = the POST /api/ops body type
    clientId?: ClientId;
    poisonStore?: PoisonIntentStore;
    newBatchId?: () => BatchId;
  }
  export function createOpQueue(replica: Replica, deps?: OpQueueDeps): OpQueue;
  ```
  Defaults: `post` → today's `apiPost("/api/ops", …)`; `clientId` → module `clientId`; `poisonStore` → `{ read: readPoisonMarkIntents, write: writePoisonMarkIntents }`; `newBatchId` → `() => newRawUid() as BatchId`.

- [ ] **Step 1: Write failing tests** in `opQueue.deps.test.ts`, using `memReplica` (`sync/memReplica.ts`):
  - `posts through deps.post with the injected client and batch ids`: enqueue one op, `await queue.drain()`; `post` was called once with `{ client_id: "client-x", batch_id: "batch-1", ops: [...] }` where `newBatchId` returns `"batch-1"`, `"batch-2"`, …
  - `reads and writes poison intents through deps.poisonStore`: a store whose `read()` returns one intent makes the queue start blocked (`retryPoisonMarks` sees it); a `post` rejecting with `new ApiError(400, "/api/ops")` causes `write` to be called with an intent naming that batch id; `globalThis.localStorage.getItem("pkm.poison-mark-intents.v1")` stays null.
  - `two queues with different deps do not share ids`: two queues, two `post` spies, each sees only its own `client_id`.
- [ ] **Step 2:** `cd web && pnpm vitest run src/sync/opQueue.deps.test.ts` → FAIL (deps ignored).
- [ ] **Step 3:** Implement: thread `deps` through; `postOps` becomes a closure over `post` and `clientId`; replace the three poison-store call sites and the `newRawUid()` mint at ~651.
- [ ] **Step 4:** Run the new test and `pnpm vitest run src/sync/` → PASS (existing `opQueue.replica.test.ts` and `opsAck.composed.test.ts` unchanged).
- [ ] **Step 5:** `pnpm typecheck` → clean. Commit `feat(pkm-yxcs): optional deps on createOpQueue`.

### Task 2: Extract `sync/clientRuntime.ts`

**Files:**
- Create: `web/src/sync/clientRuntime.ts`, `web/src/sync/clientRuntime.test.ts`
- Modify: `web/src/sync/SyncProvider.tsx` (~229-245 refs, ~388-508 repair + startup, ~510-516 onPoison, ~281-345 `onPoisonMarkFailed`, ~640-700 `retryProblem`/`discardProblem`)

**Interfaces:**
- Consumes: `OpQueue`, `Replica`, `ReplicaSync`, `SyncEvent` (`syncState.ts`), `ReplicaState`, `PoisonEvent`, `mergePoisonEvents`, `availabilityOf`, `RetryPlan` (`retryPolicy.ts`).
- Produces:
  ```ts
  export interface ClientRuntimeDeps {
    queue: OpQueue;
    replica: Replica;
    replicaSync: ReplicaSync;
    onSyncEvent: (event: SyncEvent) => void;        // SyncProvider passes applySync
    onReplicaState: (state: ReplicaState) => void;  // the startup "no-replica" report
  }
  export interface ClientRuntime {
    /** The startup effect's body: setOnline(false), pause, retryPoisonMarks, then continueStartup. */
    startup(): Promise<void>;
    /** The promise of the current/last startup run (useSocketLifecycle's startupRun). */
    startupRun(): Promise<void>;
    continueStartup(marked: readonly PoisonEvent[]): Promise<void>;
    repair(events: readonly PoisonEvent[]): Promise<void>;
    /** Execute a planRetry() result for the poison-side plans; "legacy-repair" stays in SyncProvider. */
    runRetry(plan: Exclude<RetryPlan, { kind: "legacy-repair" }>): Promise<void>;
    discardPoisonIntents(): Promise<void>;
    clearRepairTargets(): void;
    discoveringPoison(): boolean;
    /** Unsubscribes onPoison / onPoisonMarkFailed; afterwards no callback fires and no queue.resume is called. */
    dispose(): void;
  }
  export function createClientRuntime(deps: ClientRuntimeDeps): ClientRuntime;
  ```
  The runtime subscribes `queue.onPoison` and `queue.onPoisonMarkFailed` itself. `mountedRef` checks become `!disposed`. `SyncProvider` creates the runtime once (in the `replicaSync` memo's lifetime) when `replicaSync !== null`, calls `startup()` from the existing effect, and `dispose()` in the existing unmount microtask. The null-replicaSync branch (`setReplicaState({ mode: "no-replica" })`) stays in `SyncProvider`. If a name above fits badly once the code is moved, the implementer may rename it and must report the final interface.

- [ ] **Step 1: Write failing tests** in `clientRuntime.test.ts` (`// @vitest-environment node`, `memReplica` + a fake `ReplicaSync` like `replicaSync.test.ts`'s):
  - `startup with no poison resumes and starts`: call order is `setOnline(false)`, `pause("recovery")`, `retryPoisonMarks`, `poisonedBatches`, `resume("recovery")`, `replicaSync.start`; `onSyncEvent` saw `{ type: "poison-discovery-cleared" }`.
  - `startup with discovered poison repairs before start`: `rebaseAuthoritative("poison")`, `deleteBatch(id, batch_id)`, `completeAuthoritativeRepair("poison")`, `resume`, then `start`; events `repair-started`, `repair-succeeded`.
  - `concurrent poison events coalesce into one repair`: two `onPoison` emissions during one repair → one `rebaseAuthoritative` call, both batches deleted.
  - `dispose mid-startup stops resume and callbacks`: dispose while `retryPoisonMarks` is pending → after it resolves, no `resume`, no `start`, no `onSyncEvent`.
  - `unusable replica at discovery reports no-replica`: `poisonedBatches` rejects with a `ReplicaUnusableError` → `onReplicaState({ mode: "no-replica" })`, `resume`, event `replica-unusable`.
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Move the code; `SyncProvider` keeps `applySync`, legacy repair, gateway, socket lifecycle and the actions object, delegating poison-side actions to the runtime.
- [ ] **Step 4:** `pnpm vitest run src/sync/` → PASS, with `git diff --stat src/sync/SyncProvider.test.tsx` empty.
- [ ] **Step 5:** `pnpm typecheck && pnpm lint && pnpm check:fcis` → clean. Commit `refactor(pkm-yxcs): extract clientRuntime from SyncProvider`.

### Task 3: `sync_server.py` launcher

**Files:**
- Create: `server/tooling/proptest/sync_server.py`
- Test: `server/tests/test_proptest_sync_server.py`

**Interfaces:**
- Produces (Python):
  ```python
  PORT = int(os.environ.get("PROPTEST_PORT", "8978"))
  PASSWORD = "proptest-pw"
  SEED_PAGE = "Proptest"            # one page, six top-level blocks
  SEED_UIDS = ("pt_seed_1", …, "pt_seed_6")   # order_idx 0, 10, 20, 30, 40, 50
  # pt_seed_6 is reserved: no generated Edit targets it, so it is live on the
  # server for the whole example and a create of it is always a 400 (BadBatch).
  START_MS: int                      # 2026-06-15T12:00:00 Europe/London, as epoch ms
  def build_template(path: Path) -> None
  def build_app(data: Path, clock: Clock) -> FastAPI   # real create_app + the /__proptest routes
  class Clock: def set_ms(self, ms: int) -> None       # wraps a time_machine traveller, tick=False
  def main() -> int
  ```
- Routes (all behind `require_auth`):
  - `POST /__proptest/reset` → copies the template to `data/db-<n>.sqlite3`, sets `app.state.config` to a copy with that `db_path` (`dataclasses.replace` if `Config` is a dataclass), clears any `app.state` cache bound to the old DB, sets the clock to `START_MS`; returns `{"db_path": str}`.
  - `POST /__proptest/clock` body `{"ms": int}` → `clock.set_ms(ms)`; returns `{"ms": ms}`.
  - `POST /__proptest/rotate-generation` → `sync_meta.rotate_database_generation(db)` in a committed transaction; returns `{"generation": str}`.
  - `GET /__proptest/applied` → `[{"batch_id": str, "applied_at": int}]` from `applied_batches ORDER BY rowid`.
- `main()` mirrors `tests/e2e_serve.py`: temp data dir removed on exit, SIGTERM/SIGINT handler, parent-death watch, a stub `index.html` dist, `/healthz`, `PROPTEST_SERVER_LOG` for unhandled exceptions. Import shared pieces from `tests/e2e_serve.py` only if it can be done without its import-time side effects; otherwise copy the few lines.

- [ ] **Step 1: Write failing tests** with `TestClient(build_app(tmp_path, clock))`, logged in via `POST /api/login {"password": "proptest-pw"}`:
  - `test_reset_gives_a_fresh_seeded_db`: post one `create` via `/api/ops`; reset; `/api/sync/snapshot` has exactly the six seed blocks on page `Proptest`.
  - `test_clock_sets_applied_at`: `clock` to `START_MS + 5000`, post a batch; `/__proptest/applied` shows `applied_at == START_MS + 5000`.
  - `test_rotate_generation_changes_snapshot_generation`.
  - `test_applied_is_in_commit_order`: three batches → ids in post order.
  - `test_session_survives_reset_and_clock_moves`: after reset and a clock jump of +2 days, `/api/sync/snapshot` still answers 200 with the same cookie.
  - `test_proptest_routes_are_not_in_the_product_app`: `create_app(...)`'s route paths contain no `/__proptest`.
- [ ] **Step 2:** `cd server && uv run pytest tests/test_proptest_sync_server.py -q` → FAIL.
- [ ] **Step 3:** Implement. Check every `app.state` attribute `create_app` sets for anything DB-bound and record the finding in a comment at the reset route.
- [ ] **Step 4:** Tests PASS; `uv run pytest -q` (coverage still enforced: `tooling/` may be outside coverage `source` — check `pyproject.toml` and keep the gate green), `uv run pyrefly check`, `uv run ruff check` → clean.
- [ ] **Step 5:** Manual smoke: `cd server && uv run python -m proptest.sync_server` (cwd/`PYTHONPATH` as `run.py` uses), `curl -s localhost:8978/healthz`, stop it by PID. Commit `feat(pkm-yxcs): proptest sync server launcher`.

### Task 4: Gate plumbing for the web side

**Files:**
- Modify: `server/tooling/proptest/sides.py`, `server/tooling/proptest/run.py`, `server/tests/test_proptest_sides.py`
- Create: `web/vitest.props.config.ts`, `web/src/props/sync/smoke.prop.ts`
- Modify: `web/package.json` (+ lockfile), `AGENTS.md` (port table)

**Interfaces:**
- Produces:
  - `sides.available("web") is True`; `sides_for(["server/src/pkm/server/routes_ops.py"]) == ["server", "web"]`; `sides_for(["server/tests/x.py"]) == ["server"]`; `sides_for(["server/tooling/proptest/sync_server.py"]) == ["server", "web"]` (the launcher is part of the web suite).
  - `run.py`: `def web_command(seed: int | None) -> list[str]` returns `["pnpm", "exec", "vitest", "run", "--config", "vitest.props.config.ts"]`; `_run_web(repo, seed)` starts `sync_server` (env `PROPTEST_PORT=8978`, `PROPTEST_SERVER_LOG`), polls `GET /healthz` for up to 30 s, runs `web_command` in `web/` with env `PROPTEST_BASE_URL=http://127.0.0.1:8978`, `PROPTEST_PASSWORD=proptest-pw` and `PROPTEST_SEED=<seed>` when given, then terminates the server by PID in a `finally`. If 8978 is already bound, it fails with a message naming the port.
  - `web/vitest.props.config.ts`: `environment: "node"`, `include: ["src/props/**/*.prop.ts"]`, `setupFiles: []`, `testTimeout: 600_000`, `hookTimeout: 60_000`, no coverage, `pool: "forks"` with a single fork (the suite owns one server).
  - `web/src/props/sync/env.ts`: `export const BASE_URL`, `PASSWORD`, `SEED: number | undefined` read from `process.env`; throws a clear message if `PROPTEST_BASE_URL` is unset.
- [ ] **Step 1:** Update `test_proptest_sides.py` with the three `sides_for` cases above and `available("web")`, and add `test_web_command`. Run → FAIL.
- [ ] **Step 2:** Implement `sides.py` and `run.py` changes. Tests PASS.
- [ ] **Step 3:** `cd web && pnpm add -D fast-check` (latest stable 4.x); write `vitest.props.config.ts`, `env.ts`, and `smoke.prop.ts`: logs in, posts `/__proptest/reset`, asserts the snapshot has the six seed blocks, and runs a trivial `fc.assert(fc.property(fc.integer(), …), { seed: SEED })` so the fast-check wiring is proven.
- [ ] **Step 4:** `proptest/check.sh web` → smoke passes; `pnpm test:unit` does **not** list `smoke.prop.ts`; `pnpm typecheck && pnpm check:fcis` clean.
- [ ] **Step 5:** Add 8978 to the AGENTS.md port table (`proptest/check.sh web` sync server). Commit `feat(pkm-yxcs): web side of the proptest gate`.

### Task 5: Harness client and transport

**Files:**
- Create: `web/src/props/sync/serverControl.ts`, `transport.ts`, `harnessClient.ts`, `harness.prop.ts`

**Interfaces:**
- Consumes: Task 1 `OpQueueDeps`, Task 2 `createClientRuntime`, Task 4 `env.ts`; `buildHandlers`, `createReplica`, `serveRpc`, `toPortLike`, `openRawTestDb`, `failingOnce`, `createReplicaSync`, `createReconnectFlow`, `ApiError`.
- Produces:
  ```ts
  // serverControl.ts — Imperative Shell
  export interface ServerControl {
    cookie: string;
    reset(): Promise<void>;
    setClock(ms: number): Promise<void>;
    rotateGeneration(): Promise<void>;
    applied(): Promise<{ batch_id: BatchId; applied_at: number }[]>;
    snapshot(): Promise<Snapshot>;
    latestSeq(): Promise<SyncSeq>;
    postRaw(body: string): Promise<Response>;
  }
  export async function connectServer(): Promise<ServerControl>;   // logs in once per process

  // transport.ts — Imperative Shell
  export type Fault = "dropAck" | "duplicate" | "lostPull";
  export type Broken = "dropBatch" | "reidBatch" | "holdBatch" | "skipWindow";
  export interface Transport {
    fetchJson(path: string, init?: RequestInit, opts?: ApiFetchOptions): Promise<unknown>;
    post(body: OpBatch): Promise<OpsAck>;     // = fetchJson("/api/ops", POST)
    setOffline(offline: boolean): void;
    arm(fault: Fault): void;
    clearFaults(): void;
    /** Request bodies of every POST /api/ops the server answered 2xx, first time only, keyed by batch id. */
    readonly committed: ReadonlyMap<BatchId, string>;
  }
  export function createTransport(server: ServerControl, broken?: Broken): Transport;

  // harnessClient.ts — Imperative Shell
  export interface HarnessClient {
    readonly name: string;             // "A", "B", "C"
    readonly db: ReplicaDb;            // survives reload
    readonly transport: Transport;
    /** The current instances; reload() replaces them. */
    readonly queue: OpQueue;
    readonly replica: Replica;
    readonly replicaSync: ReplicaSync;
    readonly enqueued: BatchId[];      // in enqueue order, every ticket's batch id
    readonly poisoned: BatchId[];      // from onPoison
    readonly desyncs: unknown[];       // from onDesync
    unsentInMemory(): number;
    online(): Promise<void>;           // queue.setOnline(true) + reconnect.begin() (first connect after a start: begin({ viewsAreStale: true }) when pending > 0 or !hasStarted())
    offline(): void;                   // transport offline + queue.setOnline(false)
    edit(ops: BlockOp[]): Promise<BatchId>;   // awaits ticket.settled only
    pull(): Promise<void>;             // onSeq(server latest) then replicaSync.idle()
    nudge(seq: SyncSeq, force?: boolean): void;
    failNextWrite(): void;             // the next pending_ops INSERT throws (failingOnce)
    reload(): Promise<void>;
    cursor(): SyncSeq;                 // sync_client_meta "cursor"
    dispose(): Promise<void>;
  }
  export async function startClient(name: string, server: ServerControl,
                                    broken?: Broken): Promise<HarnessClient>;
  ```
  `fetchJson` mirrors `apiFetch`: non-2xx throws `new ApiError(status, path, detail)`; offline throws `new TypeError("fetch failed")` without sending. Faults are one-shot, consumed by the next matching request: `dropAck`/`duplicate` match `POST /api/ops` from **either** door (queue `post` and replicaSync's recovery flush), `lostPull` matches `GET /api/sync/changes` or `/snapshot`. `online()`/`offline()` copy `useSocketLifecycle`'s `onStatus` branch, with a comment pointing at it. `onDesync` is recorded and answered with `queue.resume("recovery")`, standing in for `repairLegacy`. The newBatchId dep yields `${name}-${n}` (prefixed to the server's 8-character minimum length). Each client's poison store is an in-memory array. `reload()` runs `runtime.dispose()`, `replicaSync.stop()`, `queue.dispose()`, `replica.dispose()` (no `closeDb`), then builds everything again over the same `db` and runs `runtime.startup()`.
  `Broken` modes act once, on the first matching request: `dropBatch` fakes `{ ok: true, ts: 0, applied: n, seq: <last seq seen>, skipped: [] }` without sending; `reidBatch` sends, then sends again with `batch_id` + `"-re"`; `holdBatch` fakes the ack for the first POST and sends its body after the next POST; `skipWindow` empties `blocks` in the first non-empty changes response.
- [ ] **Step 1: Write `harness.prop.ts`** (plain vitest tests that need the server; run with `proptest/check.sh web`):
  - `two clients converge on one edit`: A edits a seed block's text; A drains; B pulls; B's `blocks` row text equals A's.
  - `dropAck redelivers once`: A arms `dropAck`, edits; after drain, `/__proptest/applied` lists the batch once and A has no pending rows.
  - `dropAck applies to fetchJson posts too`: `A.queue.setOnline(false)` (transport still up, so the queue holds the batch), A edits, server `rotateGeneration`, A arms `dropAck`, `A.pull()` → the pull sees `needs-bootstrap` and the rebase recovery's flush posts the batch through `fetchJson` and loses its ack; then `A.online()` and quiesce → the batch is applied once and A has no pending rows.
  - `duplicate is inert`: applied once.
  - `writeFails goes through the lane`: `failNextWrite`, edit, `unsentInMemory() === 1`, drain → applied, `unsentInMemory() === 0`.
  - `reload keeps pending ops`: offline edit, reload, online → applied.
- [ ] **Step 2:** `proptest/check.sh web` → FAIL (modules missing), then implement until PASS.
- [ ] **Step 3:** `pnpm typecheck && pnpm lint && pnpm check:fcis` clean. Commit `feat(pkm-yxcs): sync harness client and faulty transport`.

### Task 6: Quiescence and the oracle

**Files:**
- Create: `web/src/props/sync/normalise.ts` (Functional Core), `oracle.ts`, `quiesce.ts`, `teeth.prop.ts`

**Interfaces:**
- Consumes: Task 5.
- Produces:
  ```ts
  // normalise.ts — Functional Core
  export interface NormalBlock { uid: string; page: string; parent_uid: string | null;
    order_idx: number; text: string; heading: number | null; collapsed: number;
    view_type: string | null; refs: string[] /* target titles, sorted */ }
  export interface NormalGraph { pages: string[] /* sorted titles */; blocks: NormalBlock[] /* sorted by uid */ }
  export function fromSnapshot(s: Snapshot): NormalGraph;
  export function fromReplica(db: ReplicaDb): NormalGraph;   // reads pages/blocks/refs tables
  export function diffGraphs(a: NormalGraph, b: NormalGraph): string | null; // null = equal; else a readable per-uid diff

  // quiesce.ts — Imperative Shell
  export async function quiesce(clients: HarnessClient[], server: ServerControl,
                                limitMs = 30_000): Promise<void>;
  // throws QuiesceError("did not settle in <limit>ms: <per-client pending/lane/cursor/latest>")

  // oracle.ts — Imperative Shell
  export interface Expectation { good: Map<string, BatchId[]> /* client → enqueue order */;
                                 bad: Set<BatchId> }
  export async function checkQuiescent(clients: HarnessClient[], server: ServerControl,
                                       exp: Expectation): Promise<void>;  // invariants 1, 2, 4, 6; then 3 (serial replay) last
  export class CursorWatch { observe(clients: HarnessClient[]): void }    // invariant 5; throws on a decrease
  ```
  `quiesce`: clear faults, every client `online()`, then loop `queue.drain()` + `pull()` on each until every client has `pendingCount() === 0`, `unsentInMemory() === 0`, `replicaSync.idle()` resolved, and `cursor() === latestSeq()`. Check during implementation whether an explicit `drain()` bypasses the retry backoff (`queueState.ts`); if it does not, the loop waits it out within `limitMs`.
  `checkQuiescent` order: convergence (each replica vs `fromSnapshot(server.snapshot())`); accounting (`applied` ids as a set equal the union of `good`, disjoint from `bad`; every `bad` id in its client's `poisoned`; no pending or poisoned rows: `replica.poisonedBatches()` empty); per-client order (filter `applied` to each client's ids → equals `good.get(client)`); no unexplained desync/poison; then serial replay: save the snapshot, `reset()`, for each applied row `setClock(applied_at)` then `postRaw(committed body)` (all must 2xx), compare `fromSnapshot` graphs. Failures throw an `Error` naming the invariant and including `diffGraphs` output.
- [ ] **Step 1: Write `teeth.prop.ts`:** one scenario per `Broken` mode plus a tampered record, each building 2 clients with that mode on client A, running a fixed command list (A edits twice, B edits once, A and B pull), quiescing, and asserting `checkQuiescent` rejects with the named invariant:
  `dropBatch` → `/accounting/`, `reidBatch` → `/accounting/`, `holdBatch` → `/per-client order/`, `skipWindow` → `/convergence/`, tampered `committed` body (text changed) → `/serial replay/`. Plus `clean run passes` (no broken mode) and `quiesce reports liveness failure` (a transport left offline after `quiesce` starts → `QuiesceError` within `limitMs`). Plus `bad batch is poisoned and repaired`: A enqueues a `create` of `pt_seed_6`; after quiesce, it is in `A.poisoned`, absent from `applied`, and `checkQuiescent` passes with it in `bad`.
- [ ] **Step 2:** Run → FAIL; implement; `proptest/check.sh web` → PASS.
- [ ] **Step 3:** A normal-suite unit test `web/src/props/sync/normalise.test.ts` for `fromSnapshot`/`diffGraphs` (equal graphs → null; one changed text → a diff naming the uid). Note: it lives under `src/` so `pnpm test:unit` runs it and coverage counts it.
- [ ] **Step 4:** Commit `feat(pkm-yxcs): quiescence and sync oracle with teeth`.

### Task 7: Commands, the property, calibration

**Files:**
- Create: `web/src/props/sync/model.ts`, `commands.ts`, `arbitraries.ts` (Functional Core), `sync.prop.ts`

**Interfaces:**
- Consumes: Tasks 5–6.
- Produces:
  - `model.ts`: `interface SyncModel { clients: string[]; online: Record<string, boolean>; freshUids: Record<string, string[]> /* unused create uids per client */; createdUids: string[]; good: Map<string, BatchId[]>; bad: Set<BatchId>; armedWriteFails: Record<string, boolean>; clockMs: number }`.
  - `arbitraries.ts`: `opsFor(model, client): fc.Arbitrary<BlockOp[]>` — 1–4 ops; kinds `create` weight 1, `update_text`/`move`/`delete`/`set_collapsed` weight 4 each (the server suite's calibrated ratio); targets drawn from `SEED_UIDS` minus `pt_seed_6`, plus `createdUids`; `create` takes the next uid from that client's `freshUids` (8 per client, `pt_<client>_<n>`), parent from the pool or null, on page `Proptest`; base hashes left undefined.
  - `commands.ts`: one `fc.AsyncCommand<SyncModel, World>` class per spec row — `Edit`, `BadBatch`, `Offline`, `Online`, `Fault(kind: "dropAck" | "duplicate" | "lostPull" | "writeFails")` (`writeFails` calls `failNextWrite()` and sets `armedWriteFails`, cleared when the lane drains), `Pull`, `Nudge(kind: "latest" | "stale" | "duplicate" | "ahead")`, `Reload`, `RotateGeneration`, `CrossMidnight`. Preconditions: `Reload` needs `unsentInMemory() === 0` at run time and no armed `writeFails`; `BadBatch` enqueues a `create` of `pt_seed_6` (parent null, page `Proptest`) and needs no armed `writeFails` and `unsentInMemory() === 0`; `Online`/`Offline` only toggle. `CrossMidnight` sets the clock to 23:59:55 local on the model's date, then +10 s; one run in four uses 2026-10-25 (BST→GMT) or 2026-03-29 (GMT→BST). Every command's `toString()` prints its arguments, so the failure report is readable.
  - `sync.prop.ts`: `fc.assert(fc.asyncProperty(fc.integer({min: 2, max: 3}), fc.commands(allCommands, { maxCommands: 30 }), …), { numRuns: NUM_RUNS, seed: SEED, verbose: 2 })`; each run resets the server, starts clients, runs `fc.asyncModelRun`, calls `CursorWatch.observe` after every command (wrap each command's `run`), then `quiesce` and `checkQuiescent`; disposes clients in `finally`. Weights via `fc.oneof` with `{ weight }`: `Edit` 10, `Pull` 3, `Nudge` 3, `Offline`/`Online` 3 each, `Fault` 3, `Reload` 2, `BadBatch` 1, `RotateGeneration` 1, `CrossMidnight` 1 (so `BadBatch` ≈ 1 in 30). Per-run counts of each command and fault go through a module-level tally printed in `afterAll`.
  - `NUM_RUNS` is exported from `sync.prop.ts`, calibrated in Step 4.
- [ ] **Step 1: Fixed scenarios first** (in `sync.prop.ts`, before the property, as plain tests through the same commands): `reload during in-flight post` (A edits, A reloads without awaiting delivery, quiesce, check) and `future nudge` (A `Nudge("ahead")`, then check `cursor() <= latestSeq()` and quiesce passes).
- [ ] **Step 2:** `proptest/check.sh web` with `NUM_RUNS = 5` → PASS, or a real finding (see Step 5).
- [ ] **Step 3:** Failure report: on failure, print the seed, path, the shrunk command list and the replay line `proptest/check.sh web --seed <seed>` (fast-check's `path` goes via `PROPTEST_PATH` env, read by `env.ts`, passed as `path` to `fc.assert`; add `--path` to `run.py`, forwarded as `PROPTEST_PATH`).
- [ ] **Step 4: Calibrate.** Time three runs of `proptest/check.sh web` on a quiet machine; set `NUM_RUNS` so the web side takes about 3 minutes. Record the tally, the measured times and `NUM_RUNS` in the commit message.
- [ ] **Step 5:** Any property failure: stop and report to the orchestrator with the seed, the shrunk commands and your diagnosis; do not change product code in this task.
- [ ] **Step 6:** Commit `feat(pkm-yxcs): sync protocol property and calibration`.

### Task 8: Docs

**Files:**
- Modify: `docs/architecture/property-checks.md`, `docs/architecture/frontend.md` (module map), `docs/architecture/sync-and-offline.md` (the `createOpQueue(replica) takes no callbacks` paragraph), the pkm-j3ui bean (body note)

Invoke the `architecture-docs` skill first. Verify every claim against the code as shipped.

- [ ] **Step 1:** `property-checks.md`: the opening says two suites; "Running it" drops "Only `server` exists yet" and adds the 8978 server, `--seed`/`--path`; the side rule now includes `server/src/` → web; the module table gains the web rows (launcher, `run.py` web runner, `vitest.props.config.ts`, `props/sync/*`); a "What the web property checks" table (commands, the six invariants, what each catches); "Reading a failure" gains the web replay; "Calibration" gains `NUM_RUNS`, the tally and the per-suite budget (about 3 min per side, total grows with suites).
- [ ] **Step 2:** `frontend.md`: `sync/clientRuntime.ts` in the module map. `sync-and-offline.md`: `createOpQueue(replica, deps?)`, deps for tests and the harness only.
- [ ] **Step 3:** `beans update pkm-j3ui --body-append` a note: the sync harness's single-client mode could compare the optimistic replica before a pull with the server after the ack.
- [ ] **Step 4:** Grep docs for stale counts ("Only `server` exists", "no properties yet"). Commit `docs(pkm-yxcs): web side of property checks`.

### Finish

- [ ] `cd web && pnpm verify` (with `set -o pipefail` if piped); `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`.
- [ ] `perf/check.sh frontend` (serial, quiet machine) — `opQueue`/`SyncProvider` changed.
- [ ] `proptest/check.sh server` and `proptest/check.sh web`.
- [ ] Final review (strongest model, mutation probes in a scratch worktree); mark pkm-yxcs completed with a Summary of Changes; merge `--no-ff` after Arthur's go-ahead.

## Addendum (2026-10-03): fixes for the property's first findings

Task 7 stopped at Step 5 with two product failures. Arthur ruled: fix both on this branch before merge, then resume Task 7 at Step 4 (calibration). Each fix follows superpowers:systematic-debugging and TDD; the shrunk case becomes an ordinary unit test that runs on every commit.

### Task 7a: Retry a failed poison repair on reconnect (pkm-f170)

**Files:** `web/src/sync/clientRuntime.ts` (+ test), the shared reconnect path (`web/src/sync/reconnectFlow.ts` and/or `useSocketLifecycle.ts`), `web/src/props/sync/harnessClient.ts` (wire the same path), `docs/architecture/sync-recovery.md`, `docs/troubleshooting.md`.

**Interfaces:**
- Produces: a reconnect retries a poison repair whose last attempt failed, running the same plan the banner's Retry runs (`planRetry` → `runRetry`, then the restart-after-repair), once per reconnect — never a retry loop while connected. The trigger lives on a path both `SyncProvider` and the harness client use, so the harness gets it through wiring, not a copy of the logic.

- [ ] **Step 1: Failing unit test** in `clientRuntime.test.ts` (or `reconnectFlow.test.ts`, wherever the trigger lands): `a poison repair that failed offline is retried on reconnect` — memReplica + fake replicaSync whose first `rebaseAuthoritative` rejects with `new TypeError("fetch failed")`; after the reconnect hook, `rebaseAuthoritative` was called twice, both poisoned batches deleted, `queue.resume("recovery")` called, `replicaSync.start` called; events `repair-failed` then `repair-started`, `repair-succeeded`. Plus `a reconnect with no failed repair does nothing` and `a repair that fails again waits for the next reconnect` (no loop).
- [ ] **Step 2:** run → FAIL; implement; run → PASS. `SyncProvider.test.tsx` still passes unmodified (if a SyncProvider-level test is genuinely needed, add a new test, don't edit old ones).
- [ ] **Step 3:** wire the harness client's `online()` through the same path; the props fixed scenario `poison repair cut off by offline settles after reconnect` (one client: BadBatch, BadBatch, Offline, Online → quiesce + checkQuiescent pass). `proptest/check.sh web` passes, and the F1 replay line (`--seed -496395878 --path 35:4:13:14:13:11:11:12 --replay-path JAGAZAr:VB`) passes.
- [ ] **Step 4:** docs: `sync-recovery.md` (where the repair banner's Retry is described: a reconnect now retries too), a `troubleshooting.md` row (symptom "edits on one device never reach the server after a network blip during a rejected-batch repair", cause, owning section, pkm-f170). Gates: typecheck, lint, check:fcis, test:unit. Commit `fix(pkm-f170): retry a failed poison repair on reconnect`.

### Task 7b: Re-ship the destination sibling group of a skipped create/move (pkm-hz8w)

**Files:** the server's skip path (`server/src/pkm/server/ops_apply.py` / `ops_core.py`, wherever skipped creates/moves are decided and executed), `server/tests/` (new regression test), `docs/architecture/sync-recovery.md`, `docs/architecture/backend.md` (§ Missing targets / Concurrent structure edits), `docs/troubleshooting.md`.

**Interfaces:**
- Produces: when the server skips a `create` or `move` (missing block, missing parent, cycle), it records a journal row for every live block in the op's destination sibling group (same page and `parent_uid` the op named; top level of the op's page when `parent_uid` is null), without changing any column, so the next `/api/sync/changes` window re-ships their true `order_idx`. Nothing else about the skip changes (ack `skipped`, daily-note entries, applied state).

- [ ] **Step 1: Failing server test** `test_skipped_move_reships_destination_siblings`: seed a page with top-level blocks `s1..s4` at 0/10/20/30; delete `s2` in one batch; record `next_since`; post `move s2 → parent null, index 0`; the ack lists the move as skipped; `GET /api/sync/changes?since=<recorded>` includes `s1`, `s3`, `s4` with order_idx 0/20/30 and the `s2` tombstone. Add the cycle-skip and missing-parent variants the same way (missing parent: nothing to re-ship beyond what tombstones already carry — assert no error and no stray rows).
- [ ] **Step 2:** run → FAIL; implement; run → PASS. Check how the journal triggers fire (an UPDATE that changes nothing may or may not journal, depending on the trigger's WHEN clause) and that FTS/refs/`updated_at` are untouched by the touch.
- [ ] **Step 3:** `uv run pytest -q`, pyrefly, ruff; `proptest/check.sh server` still passes (the server suite's model compares block state, not the journal); `proptest/check.sh web` passes and the F2 replay line (`--seed -496395878 --path 36:0:2:1:4:5:4:4:6:6:6:6:6:10:10:10:10:10:10:10:10:10:10:10:10:10 --replay-path 'AAAACABAGA/G:V1'`) passes.
- [ ] **Step 4:** docs: `sync-recovery.md` (the keepSlot / skipped-op notes: a skip re-ships the destination group, so the transient misordering ends at the next pull), `backend.md` missing-targets/concurrent-structure tables, a `troubleshooting.md` row (pkm-hz8w). If `web/src/api/openapi.json` is affected (it should not be), regenerate. Commit `fix(pkm-hz8w): re-ship the destination siblings of a skipped create or move`.

### Then: Task 7 resumes at Step 4 (calibration), then Task 8.

### Task 7c: A batch reads the clock once (pkm-hb4x) — done (b331b4e4)

### Task 7d: The feed names pending batches it already holds (pkm-undg)

The property found F7: `reapplyPending` replays a pending batch over a window that already contains it (the server committed it, the client has not processed the ack), double-applying it. Live without a reload: a lost ack plus the batch's own WS nudge. No client-only rule can be correct (identical replica state and window need opposite answers). Arthur ruled option B.

**Design.**
- The pull sends the ids of its non-poisoned pending batches — only the head prefix of the durable queue (delivery is FIFO, so only a prefix can be committed), capped so the GET stays small; if a cap is needed, choose it from measurement and say why.
- `GET /api/sync/changes` and `GET /api/sync/snapshot` accept them (e.g. a repeated `pending` query param) and answer, from the **same read transaction** that hydrates the window, which of them are in `applied_batches`, with each one's stored ack `seq` and `skipped` (new response field, e.g. `applied_batches: [{batch_id, seq, skipped}]`). A batch's writes and its `applied_batches` row commit together, so "present in this read" is exactly "this window's rows include it". No ids → no extra query, field empty/absent.
- The worker, inside the window's transaction and **before** `reapplyPending`, deletes the named pending rows (recording their acked seqs as the drain's ack path does) and returns the dropped ids. The same for `applySnapshot`.
- `replicaSync`/the queue resolve the dropped rows' delivery tickets and outbox entries exactly as a drain ack would (`finishDelivery`/`forget` or their equivalents), and a non-empty `skipped` bumps resync as an ack's would.
- Old server ↔ new client and new server ↔ old client both keep working (additive both ways).

**Files (expected):** `server/src/pkm/server/routes_sync.py` (+ `sync_core.py` if the read belongs there), `server/src/pkm/contracts/…` (response models), `web/src/api/openapi.json` + generated types (regenerate per backend.md § Generated artifacts), `web/src/replica/apply.ts`, `web/src/replica/workerHandlers.ts`, `web/src/replica/client.ts`, `web/src/sync/replicaSync.ts`, `web/src/sync/opQueue.ts`, tests beside each, `web/src/props/sync/sync.prop.ts` (fixed scenario), docs.

- [ ] **Step 1: Failing tests** (real sqlite via `openTestDb` on the web side):
  - `apply.test.ts` `describe("applyChanges: a window that names a pending batch as applied drops it instead of replaying it")` — seed s1..s6, enqueue the batch, apply a feed holding the server's post-batch rows and naming the batch; assert blocks equal the server rows, no pending rows, and a following empty window changes nothing. Cases: `move s4 0; move s4 1`; `move s4 0; move s5 0`; `move s4 0; create n1 0`; `update_text s1 "mine"` under a window holding a later `"theirs"`; a partial window shipping only the siblings. Converse: the same window not naming the batch still replays it.
  - `workerHandlers.test.ts`: the handler returns dropped ids and records acked seqs; a later `deleteBatch` for a dropped row is a harmless no-op; only rows pending when the pull snapshotted its ids are dropped (a row enqueued after the ids were read is untouched).
  - `replicaSync.test.ts`: the pull sends the pending head ids and hands dropped ids to the queue; the queue resolves their tickets; a dropped batch with `skipped` bumps resync.
  - Server: the changes and snapshot routes return only ids present in `applied_batches` within the same read; none without the param; no extra query without the param; unknown ids ignored.
- [ ] **Step 2:** RED, implement, GREEN. Regenerate OpenAPI and generated types.
- [ ] **Step 3: Property.** Add the fixed scenario `lost ack, own nudge pulls before the redelivery` to `sync.prop.ts` (arm `dropAck`, edit two moves of one block, wait for the commit, `pull()`, quiesce, `checkQuiescent`) — it must fail before the fix and pass after. The F7 replay line passes; F2/F4/F6 replays still pass; `proptest/check.sh server` and `web` pass.
- [ ] **Step 4: Gates.** Server pytest/pyrefly/ruff; web typecheck/lint/check:fcis/test:unit; `perf/check.sh backend` and `perf/check.sh frontend` (serial, quiet machine).
- [ ] **Step 5: Docs.** `sync-recovery.md` § Windows and the pending queue (the new field and why the same read transaction makes it exact), § Recovery never erases intent (the replay-over-echo paragraph; correct the "drifting per window" row, citing pkm-sj5l for the remaining transient drift); `backend.md` API table; a `troubleshooting.md` row (pkm-undg). Commit `fix(pkm-undg): the changes feed names pending batches it already holds`.
