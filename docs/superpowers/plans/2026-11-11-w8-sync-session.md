# W8 Sync Session: Task-Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Implementers work under the epic's implementer brief; this plan does not restate it.

**Goal:** One module, `sync/session.ts`, composes the op queue, `replicaSync`, `clientRuntime`, `legacyRepair` and `reconnectFlow`, and folds every sync event through `transitionSync`. `SyncProvider` and the sync property harness both run it, so the property checks the composition the app runs, including the replica-state banner mapping the harness skips today.

**Architecture:** `createSyncSession(deps)` is an Imperative Shell with no React in it. It owns the parts, their listeners, the socket status, the first-connect gate, the problem fold and the `SyncActions` object. `SyncProvider` keeps React state, the four contexts, the owned worker, the offline gateway and the unload guard; `useSocketLifecycle` keeps the socket and the StrictMode-deferred teardown. `syncState.ts` gains one `replica-state` event that owns every mode-driven rule.

**Tech stack:** React 18, vitest + jsdom, fast-check (`web/src/props/gate.ts`), the sync property suite against a server (`proptest/check.sh web --file sync`).

**Source:** `docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md` § W8, with its Global Constraints and Review Focus. Branch `refactor/sync-session`, read at `9dc822c7`. W9, W10 and W11 follow on the same files, serially.

## Global Constraints

The epic's Global Constraints apply unchanged. The ones that bite here:

- Web verification for implementers is the web gates without Playwright: `cd web && pnpm typecheck && pnpm lint && pnpm lint:comments && pnpm check:fcis && pnpm test:coverage && pnpm build` (all with `--config.verify-deps-before-run=false`; never `pnpm add/install/update`, `node_modules` is a symlink).
- `pnpm verify`, `perf/check.sh frontend` and `proptest/check.sh web` are the orchestrator's, run serially. The sync suite needs the server `proptest/check.sh` starts on port 8978, so no implementer runs it directly.
- Do not re-propose: folding `usable` into `ReplicaState`, a `socket.ts` phase union, changing `OpsAck.applied`, removing the replay budget.
- Converted machines: W8 moves the banner's replica-state mapping into `transitionSync`. It keeps every sync suite green and leaves its property rule to W19 (the row is already in W19's table; Task 5 corrects it to what ships).
- Comments: no bean ids, line numbers or plan pointers; 80 columns in comments; AGENTS.md's banned word stays out. Docs under `docs/architecture/` go through the `architecture-docs` skill.

## Review Focus

Failure modes no single task's tests are certain to exercise, most likely first. Each names the test that pins it.

1. **An unmount during the first connect.** The first connect waits on the startup run; a real unmount (or a harness reload) can land inside that wait. Nothing may then drain, start or repair through a disposed queue. Task 2 `a first connect whose startup outlives dispose starts nothing`.
2. **The gap between effect cleanup and the deferred dispose.** Today the listeners unsubscribe at cleanup, a microtask before dispose. The session's listeners live until dispose, so each must check liveness first: `legacyRepair.run` calls `repairSessions` without asking `isMounted`. Task 2 `a desync after unmount starts no repair`.
3. **StrictMode replay.** One subscription set, one startup, one connect lifecycle, the worker closed then terminated once. The `ownership and StrictMode lifecycle` describe in `SyncProvider.test.tsx`, unedited (Task 3).
4. **Ready while disconnected.** The resync bump moves from an effect after the mode's render to the mode report itself. Views must still refetch through the shim: the gateway's `modeRef` is written in the same render that carries the new `resyncGeneration`. `SyncProvider.test.tsx` "cold start offline: a hydrated replica reaches ready and bumps resync" (Task 1).
5. **Banner precedence.** A stalled report never replaces a delivery problem, and a re-report keeps a reset the user is watching. Task 1's ported `replica-stalled lifecycle` cases.

---

## Where the code disagrees with W8

The code wins in each case; the tasks below are written to the code.

| W8 says | The code says | What the plan does |
|---|---|---|
| The only composition is in `SyncProvider.tsx` and `useSocketLifecycle.ts` | Also `props/sync/queueHarness.ts`, which wires `clientRuntime` and `legacyRepair` around a stand-in `replicaSync`, worker and server so the queue property can step them one command at a time | W8 leaves `queueHarness.ts` composed by hand: a session would bring the real `replicaSync` its stand-in replaces on purpose. Its header names `createSyncSession` as the composition it mirrors (Task 4). See Questions 3 |
| `harnessClient.ts` copies the composition and never runs `onState`'s mapping | It also skips: the durable-count read SyncProvider's listener effect makes before startup; both `onSkipped` subscriptions, so it never folds `ops-skipped`; `onPending`; the echo filter; `mode-ready-check`. It has one guard the app lacks: a first connect returns if the life ended during the startup run | The session runs everything the app runs, and adopts the harness's guard as a liveness check (Task 2) |
| `SyncSessionDeps` carries `emit(event: SyncEvent)`; SyncProvider folds | `SyncSession.actions` needs the current problem: `retryProblem`, `discardProblem` and `dismissProblem` read `problemRef`, and the fold keeps `legacyBehindRef` beside it. Left in SyncProvider, the fold is out of the actions' reach and out of the harness's | The session owns the fold (`SyncState`, `transitionSync`, the `bump-resync` effect) and reports the problem and each resync. An optional `report.event` observer gives the harness its `syncEvents`. See Questions 2 |
| `SyncSessionDeps` carries the socket factory, the clock and timers | No part takes a clock: `replicaSync` and `opQueue` call `setTimeout` themselves, and the one knob is `ReplicaSyncDeps.retryBaseMs`. The harness has no socket: it drives status itself and awaits the first connect's chain, which a socket callback cannot return | The socket stays in `useSocketLifecycle`. The session exposes `onSocketStatus(up): Promise<void>`, `onSeq` and `onBatch`; the deps carry `retryBaseMs` and no clock |
| `startup(): Promise<void>` | Startup is three effects today: the listener effect's `queue.refreshPending()`, then `runtime.startup()` (or `no-replica` when there is no runtime), then the socket effect's `readInitialPending`. StrictMode replays each, so `runtime.startup()` runs twice in development | Listeners subscribe when the session is built. `startup()` makes the two reads and the runtime start in the app's order, once per session: a second call returns the first run |
| `retryFailedRepair()` is public | Once the harness stops copying it, only the reconnect flow calls it | It stays inside the session, as `createReconnectFlow`'s dep; Task 2 pins its order through `onSocketStatus` |
| `dispose()`: stop `replicaSync`, dispose the queue, then owned parts | Matches `useSocketLifecycle`'s deferred teardown. The owned parts are the runtime (the session's) and the worker-backed replica (SyncProvider's `disposeOwned`; the harness's `endLife`). `legacyRepair` has no `dispose` and relies on `isMounted` | `dispose()` stops `replicaSync`, disposes the queue, disposes the runtime, and unsubscribes the session's listeners; the replica stays its creator's to dispose |
| `harnessClient.ts` deletes `goOnline`, `endLife` and `mount` | `goOnline`/`goOffline` also flip the harness transport's offline flag, and `endLife` awaits the old worker's close and cuts the life's database handle: harness-owned work | They stay as thin harness steps; their composition bodies go, and `mount` becomes `session.startup()` |
| New event `{ type: "replica-state", state, status }` | Two writers report a mode: `replicaSync.onState` and `runtime.onReplicaState` (`no-replica`, no error), plus SyncProvider's null-runtime effect. A second mode rule, `mode-ready-check`, runs in an effect after the mode renders. Once the fold leaves React nothing can run a rule after a render. The old mapping tests `statusRef.current === "connected"`, so "offline" covers both `connecting` and `reconnecting` | One event `{ type: "replica-state"; prev: ReplicaMode; state: ReplicaState; status: SyncStatus }` from every mode report. It owns the stalled, unstalled and unusable mapping and the ready-while-disconnected bump. `replica-stalled`, `replica-unstalled` and `mode-ready-check` go: nothing else emits them. `replica-unusable` stays, since the runtime emits it directly (W10's single mode writer may retire it). Tests cover all three statuses. See Questions 1 |
| The harness wraps the replica | Twice, plus a third view: the queue's (a lost `enqueue` reply), `replicaSync`'s (`init`, `applyChanges`, `applySnapshot`) and the runtime's (`poisonedBatches` recording). The method sets are disjoint: only the queue calls `enqueue`, only `replicaSync` calls `init`, `applySnapshot` and `applyChanges`, only the runtime calls `poisonedBatches` | One wrapper replica goes to the session. `HarnessClient.replica` stays the raw replica, so the oracle's reads record nothing |
| Red test: `session.test.ts` pins the first-connect order | The first-connect pins today are the five tests in `useSocketLifecycle.test.ts`, written against `SocketLifecycleDeps`, which goes | Task 2 ports all five to `session.test.ts` before Task 3 deletes them |
| (not in W8) | `sync-and-offline.md` § Key pieces says no `OpQueue` method may emit synchronously because SyncProvider subscribes in an effect after the commit. The session subscribes while it is built, during render | Still safe: the session starts no work before `startup()`, which SyncProvider calls from an effect, and no report may run during render. Task 5 restates the reason |
| (not in W8) | Comments name the old owners: `replica/errors.ts` (`absentReplica`), `clientRuntime.ts` (two), `reconnectFlow.ts` header, `replicaSync.ts` (`hasStarted`), `sync/barrier.test.ts` header, `props/sync/commands.ts` (`canEdit`) | Task 3 and Task 4 rewrite each to name the session |
| Gate: `proptest/check.sh --file sync` | `--file` is web only: `proptest/check.sh web --file sync` | Written that way below |

## The session's interface

Specified exactly; the bodies are the code they replace, moved.

```ts
// web/src/sync/session.ts
// pattern: Imperative Shell

/** Moved unchanged from SyncProvider.tsx, which re-exports it. */
export interface SyncActions { /* … */ }

/** The open outline editors: outline/outlineSessions.ts in the app. */
export interface OutlineHooks {
  track(ticket: WriteTicket, ops: BlockOp[]): void;
  attachReplay(ticket: WriteTicket, title: RawTitle,
               replay: readonly OutlineReplayAction[]): void;
  /** legacyRepair's repairSessions. */
  repairSessions(onStable: () => void): Promise<void>;
}

/** Each is called only while the session is live. */
export interface SyncReports {
  status(status: SyncStatus): void;
  replicaState(state: ReplicaState): void;
  /** Only when the problem's identity changes. */
  problem(problem: SyncProblem | undefined): void;
  resync(): void;
  pending(n: number): void;
  unsentInMemory(n: number): void;
  /** Every event the session folds, in order. */
  event?(event: SyncEvent): void;
}

export interface SyncSessionDeps {
  /** null: no replica in this environment; the queue runs on
   * absentReplica() and delivers online-only. */
  replica: Replica | null;
  clientId: ClientId;
  fetchJson: ReplicaSyncDeps["fetchJson"];
  queue?: Omit<OpQueueDeps, "clientId">;
  retryBaseMs?: number;
  outlines: OutlineHooks;
  /** False between an unmount and its deferred dispose. */
  isMounted?: () => boolean;
  report: SyncReports;
}

export interface SyncSession {
  /** One object for the session's life. */
  readonly actions: SyncActions;
  readonly queue: OpQueue;
  readonly replicaSync: ReplicaSync | null;
  /** Once per session; a later call returns the first run. Resolves with
   * the runtime's startup run. */
  startup(): Promise<void>;
  /** The socket's status callback. Resolves when the connect's chain
   * settles and never rejects. Throws if called before startup(). */
  onSocketStatus(up: boolean): Promise<void>;
  onBatch(batch: WsBatch): void;
  onSeq(frame: WsSeq): void;
  status(): SyncStatus;
  replicaState(): ReplicaState;
  problem(): SyncProblem | undefined;
  dispose(): void;
}

export function absentReplica(): Replica;   // moved from SyncProvider.tsx
export function createSyncSession(deps: SyncSessionDeps): SyncSession;
```

What the body does, in order, so that each task can check it against the code it replaces:

- **Built:** the queue on `replica ?? absentReplica()` with `{ ...deps.queue, clientId }`; `legacyRepair` (`onEvent: fold`, `resume: () => queue.resume("lane")`, `isMounted: live`); `replicaSync` when there is a replica (`isOffline: () => status === "reconnecting"`, `onState: reportMode`, `retryBaseMs`); the runtime when there is a `replicaSync` (`onSyncEvent: fold`, `onReplicaState: reportMode`, `isMounted: live`); the reconnect flow (`onResync: report.resync`, `retryFailedRepair`: the runtime's, then the legacy repair's); the listeners: `onDesync` → `legacyRepair.run`, the queue's and `replicaSync`'s `onSkipped` → `ops-skipped`, `onPending`, `onUnsentInMemory`, `onDrain` → `reconnect.observeDrain`. Every listener returns at once unless `live()`. Building calls no report.
- **`live()`** is `!disposed && (deps.isMounted?.() ?? true)`.
- **`reportMode(next)`:** unless live, nothing. Else `prev = current.mode`, `current = next`, `report.replicaState(next)`, then `fold({ type: "replica-state", prev, state: next, status })`. The same order as SyncProvider's `onState`: state first, then the mapping.
- **`fold(event)`:** unless live, nothing. Else `transitionSync`, keep the new `SyncState`, `report.event?.(event)`, `report.problem` if the problem's identity changed, `report.resync()` per `bump-resync`. As `applySync` does now, the state is updated before any report, so a fold triggered from inside a report sees it.
- **`startup()`:** if there is a replica, `void queue.refreshPending()`. Then `runtime.startup()`, or with no runtime `reportMode({ mode: "no-replica" })`. Then `initialPending = replica ? queue.refreshPending() : Promise.resolve(0)`.
- **`onSocketStatus(up)`:** `queue.setOnline(up)`; `status = up ? "connected" : "reconnecting"`. When up and connected before: `reconnect.begin()`, rejection logged as `"reconnect.begin() failed"`. When up for the first time: `initialPending`, then the runtime's `startupRun()`, then return unless live, then `reconnect.begin({ viewsAreStale: true })` if `n > 0` or a `replicaSync` exists that has not started; rejection logged as `"first-connect reconnect.begin() failed"`. Then mark connected-once, then `report.status(status)` if live. The chain starts before the report, as now.
- **`onBatch`:** drop the session's own `clientId`; hand the rest to `actions.subscribe`'s set. **`onSeq`:** `replicaSync?.onSeq(frame.seq, frame.force === true)`.
- **`actions`:** today's `SyncProvider` actions, reading the session's `SyncState` where they read `problemRef`; `enqueue` calls `outlines.track`, `attachOutlineReplay` calls `outlines.attachReplay`.
- **`dispose()`:** once. `disposed = true`; `replicaSync?.stop()`; `queue.dispose()`; `runtime?.dispose()`; unsubscribe the listeners.

## Tasks

Each task is one reviewable commit series in its own worktree off `refactor/sync-session`, merged back with `--no-ff`. "Web gates" means the list in Global Constraints.

### Task 1: One `replica-state` event owns the mode rules

**Implementer:** opus (small, but it moves the ready-while-disconnected bump from after a render to the report, the one behaviour change in the app).

**Files:** `web/src/sync/syncState.ts`, `syncState.test.ts`, `SyncProvider.tsx`.

**Interfaces:**
```ts
// syncState.ts, in SyncEvent
| { type: "replica-state"; prev: ReplicaMode; state: ReplicaState;
    status: SyncStatus }
// removed from SyncEvent: "mode-ready-check", "replica-stalled",
// "replica-unstalled"
```
- `transitionSync`'s `replica-state` case: `stalled` behaves as the old `replica-stalled`; `ready` as `replica-unstalled`; `recovery-failed` as `replica-stalled` only when `status === "connected"`; `no-replica` with an `error` as `replica-unusable`; anything else leaves the problem. Then it appends `bump-resync` when `prev !== "ready"`, the mode is `ready` and `status !== "connected"`. The old cases' bodies become private helpers the new case calls; `replica-unusable` keeps its own case and shares its helper.

- [ ] **Red tests** in `syncState.test.ts`, `describe("transitionSync replica-state")`, from an empty state unless named:
  - `stalled raises replica-stalled whatever the socket` (three statuses)
  - `recovery-failed raises replica-stalled only while connected` (connected raises; connecting and reconnecting leave the problem)
  - `ready clears an idle stalled problem`; `ready keeps a stalled problem whose reset is running`
  - `no-replica with an error raises replica-unusable`; `no-replica without an error changes nothing`; `starting changes nothing`
  - `turning ready while disconnected bumps resync` (prev `starting`; `connecting` and `reconnecting`); `turning ready while connected does not bump`; `a ready re-report does not bump`
  - Port every case in `transitionSync replica-stalled lifecycle` and `transitionSync mode-ready resync` to `replica-state`, keeping its name. None is deleted without its replacement.
- [ ] **Run; expect FAIL** (the event does not exist).
- [ ] **Implement the core.**
- [ ] **Rewire SyncProvider.** One local `reportReplicaState(next: ReplicaState)`: if mounted, `setReplicaState(next)`; then `applySync({ type: "replica-state", prev: reportedModeRef.current, state: next, status: statusRef.current })`, then `reportedModeRef.current = next.mode`. `replicaSync`'s `onState`, the runtime's `onReplicaState` and the null-runtime effect call it. Delete the `mode-ready-check` effect and `prevModeRef`.
- **Done:** web gates green; `SyncProvider.test.tsx` green unedited, or each edit named with its reason in the commit message (an edit is evidence the timing change is visible, so report it); `git grep -n -e '"replica-unstalled"' -e '"mode-ready-check"' web/src` finds nothing, and `"replica-stalled"` appears only as a problem kind.

### Task 2: `createSyncSession`

**Implementer:** opus (ordering of the startup reads and the first connect, liveness across the deferred teardown, the dispose order).

**Files:** `web/src/sync/session.ts` (new), `session.test.ts` (new), `SyncProvider.tsx` (the two moves only).

- First commit, pure moves: `SyncActions` and `absentReplica` into `session.ts`. `SyncProvider.tsx` imports `absentReplica` and re-exports `SyncActions`, so its importers keep their import.
- Second commit: the session as specified above, unused by anything yet. The composition is moved from `SyncProvider.tsx` and `useSocketLifecycle.ts` with the comments that explain each step; the two copies coexist until Task 3.
- Tests use the real parts over `memReplica` (with logging overrides, as `fakeReplicaForProvider` in `SyncProvider.test.tsx` logs), a `fetchJson` fake and a `queue.post` fake. The dispose order is read through `vi.spyOn(session.replicaSync!, "stop")`, `vi.spyOn(session.queue, "dispose")` and a `vi.mock("./clientRuntime")` wrapper that records `dispose`.

- [ ] **Red tests** in `session.test.ts`:
  - Ported from `useSocketLifecycle.test.ts`, under their own names: the first-connect `begin()` rejection is logged; a reconnect's `begin()` rejection is logged; offline cold start with an empty queue still bootstraps once online; online cold start with a bootstrapped replica and an empty queue skips the reconnect protocol; each connect retries a failed repair, the first after the startup gate.
  - `startup reads the durable count, starts the runtime, then reads the initial pending` (the replica's call log)
  - `a second startup returns the first run and starts nothing`
  - `with no replica, startup reports no-replica and the queue delivers online-only`
  - `socket status before startup throws`
  - `a first connect with pending rows bumps resync even when the pull moved nothing`
  - `a later connect retries the poison repair, then the legacy repair, then drains` (order through the runtime and `outlines.repairSessions` fakes)
  - `a first connect whose startup outlives dispose starts nothing` (no `drain`, no `init`, no POST after the startup run resolves)
  - `a desync after unmount starts no repair` (`isMounted` false, the queue raises a desync: `outlines.repairSessions` is not called)
  - `a stalled report raises replica-stalled while connected` (through `replicaSync`'s real `onState`: `STALL_AFTER_FAILURES` failed pulls; `report.problem` and `session.problem()` agree)
  - `an own echo reaches no subscriber`
  - `dispose stops replicaSync, then disposes the queue, then the runtime, once`
- [ ] **Run; expect FAIL** (module missing).
- [ ] **Implement.**
- **Done:** web gates green; `session.ts` is covered by `session.test.ts`.

### Task 3: SyncProvider and the socket lifecycle run the session

**Implementer:** opus (StrictMode replay, the deferred teardown, React setters as reports).

**Files:** `sync/SyncProvider.tsx`, `useSocketLifecycle.ts`, `useSocketLifecycle.test.ts`; comments in `replica/errors.ts`, `sync/clientRuntime.ts`, `reconnectFlow.ts`, `replicaSync.ts`, `barrier.test.ts`.

**Interfaces:**
```ts
// useSocketLifecycle.ts
export interface SocketLifecycleDeps {
  /** Mount-stable: the effect runs once per mount. */
  session: SyncSession;
  mountedRef: MutableRefObject<boolean>;
  /** After session.dispose(): the worker-backed replica SyncProvider made. */
  disposeOwned: () => void;
}
```
- SyncProvider builds the session once, as it builds the queue now (`useMemo(…, [])`), with `replica: replicaRef.current`, `clientId`, `fetchJson: apiFetch`, `outlines` from `outlineSessions.ts`, `isMounted: () => mountedRef.current`, and its React setters as `report` (`resync` is `setResyncGeneration((n) => n + 1)`). It calls `session.startup()` from an effect. The gateway reads `session.status()` where it read `statusRef`, keeps `modeRef` (written during render, as now), and refreshes through `session.queue`. `actions` is `session.actions`. Delete `applySync`, `problemRef`, `legacyBehindRef`, `statusRef`, `reportedModeRef`, `subsRef` and every part memo.
- The hook's effect: `mountedRef.current = true`; `connectSocket({ onBatch: session.onBatch, onSeq: session.onSeq, onStatus: (up) => { void session.onSocketStatus(up); } })`. Cleanup: `mountedRef.current = false`, `handle.close()`, then the microtask: return if remounted, else `session.dispose()` and `disposeOwned()`. Its header keeps the StrictMode reasoning and drops the phases the session now owns.
- `useSocketLifecycle.test.ts`: delete the five tests Task 2 ported (name them in the commit message); add `a socket status reaches the session`, `a real unmount disposes the session, then the owned replica, once`, `a StrictMode replay keeps the session`.
- Rewrite the comments in the Files list that name SyncProvider's or `useSocketLifecycle`'s composition so they name the session.
- **Done:** web gates green; `SyncProvider.test.tsx`, `SyncProvider.reconnectRepair.test.tsx`, `syncSlices.test.tsx` and `connectionAware.test.tsx` green unedited; `git grep -n -e createReplicaSync -e createClientRuntime -e createLegacyRepair -e createReconnectFlow -e createOpQueue web/src/sync/SyncProvider.tsx web/src/sync/useSocketLifecycle.ts` finds nothing.

### Task 4: The sync harness runs the session

**Implementer:** opus (life teardown, the merged replica view, the timed connect).

**Files:** `web/src/props/sync/harnessClient.ts`, `queueHarness.ts` (header only), `commands.ts` (one comment), `sync.prop.ts` (tally only).

- `buildLife` builds one wrapper replica holding the three views (lost reply on `enqueue`; `init`, `applyChanges`, `applySnapshot` as now; `poisonedBatches` recording) and calls `createSyncSession` with: `clientId` per life; `fetchJson: doors.fetchJson`; `queue: { post: doors.post, poisonStore, newBatchId }`; `retryBaseMs`; `outlines` with no-op `track` and `attachReplay` and the existing stand-in `repairSessions`; `isMounted: () => !state.ended`; `report` writing `unsentInMemory` and `lanePushes`, and `event` pushing to `syncEvents`. The harness's own `onDesync` (desyncs) and `onPoison` (poisoned) listeners subscribe on `session.queue`.
- `LifeState` loses `status`, `mode` and `everConnected`. `mode()` reads `session.replicaState().mode`; `canEdit()` is `computeEditability(session.status(), mode)`; `queue`, `replicaSync` read the session's. `HarnessClient`'s interface is unchanged, so `commands.test.ts`'s fake needs no edit.
- `mount` becomes `session.startup()`. `goOnline` keeps the transport flip and returns `session.onSocketStatus(true)`; `goOffline` keeps the flip and calls `session.onSocketStatus(false)`. `endLife` sets `ended`, calls `session.dispose()`, then awaits `replica.dispose()` and ends the handle as now. `edit` enqueues through `session.actions.enqueue`.
- Rewrite the header: the harness runs `createSyncSession`, the composition SyncProvider runs; the legacy repair's outline read and the replica views are the stand-ins. `syncEvents`' doc: every event the session folds.
- Tally (no rule, no floor): at the end of each example, `count(\`Problem at settle: ${kind ?? "none"}\`)` per client, from `session.problem()`. It shows how often the property reaches each banner kind now that it runs the mapping; W19 sets floors with its rule. Register the labels in `REACH`'s no-floor comment with that reason.
- **Done:** web gates green; `git grep -n -e createReconnectFlow -e createClientRuntime -e createLegacyRepair -e createReplicaSync -e createOpQueue web/src/props/sync/harnessClient.ts` finds nothing; the orchestrator's `proptest/check.sh web --file sync` passes (see Property gate).

### Task 5: Docs say what W8 made true

**Implementer:** sonnet (`architecture-docs` skill). Last.

**Files:** `docs/architecture/sync-and-offline.md`, `sync-recovery.md`, `frontend.md`, `checks.md`; the W19 row in `docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md`.

- `sync-and-offline.md` § Key pieces: the Orchestration row names `sync/session.ts` (`createSyncSession`) as the one composition, run by SyncProvider and by the sync property harness; SyncProvider keeps React state, the contexts, the owned worker and the offline gateway; `useSocketLifecycle.ts` the socket and the deferred teardown. The sentence under the table keeps the rule (no `OpQueue` method emits synchronously) with the new reason: the session subscribes as it builds the queue and starts no work before `startup()`, which SyncProvider calls from an effect after the commit.
- § When views refetch: the first-connect row's owner is `session.ts`; the ready-while-disconnected row reads `syncState.ts` (`replica-state`).
- `sync-recovery.md` § Replica mode: the `no-replica` row's "SyncProvider when there is no replica" becomes the session; "SyncProvider raises the `replica-unusable` banner" becomes `transitionSync`, from the `replica-state` report. Leave the "Nothing reports the death…" sentence to W10.
- `frontend.md` § State management: the session holds the queue and connectivity; SyncProvider publishes them.
- `checks.md` § Property gate, the `sync/` row: the harness runs `createSyncSession`.
- W19 row: "Banner under `replica-state` events (`transitionSync`)" stays; add that the harness reads `session.problem()` and that Task 4's `Problem at settle` labels are its reach data.
- No troubleshooting row: nothing here fixes a bug.
- **Done:** `node .claude/skills/architecture-docs/check-docs.mjs` passes; `lint:comments` green.

## Order and parallel lanes

```
T1 -> T2 -> { T3 , T4 } -> T5
```

T1 before T2: the session folds `replica-state`. T3 and T4 run in parallel worktrees once T2 merges: they share no file. If either needs a change to `session.ts`, it makes that change as its first commit, so the other can take it; the second to merge rebases.

| File | Tasks | Rule |
|---|---|---|
| `sync/syncState.ts`, `syncState.test.ts` | T1 | |
| `sync/SyncProvider.tsx` | T1, T2 (moves), T3 | serial |
| `sync/session.ts`, `session.test.ts` | T2; T3 or T4 only as a first commit | see above |
| `sync/useSocketLifecycle.ts`, `.test.ts` | T3 | |
| comments in `replica/errors.ts`, `clientRuntime.ts`, `reconnectFlow.ts`, `replicaSync.ts`, `barrier.test.ts` | T3 | |
| `props/sync/*` | T4 | |
| docs and the epic plan's W19 row | T5 | implementers leave docs to T5 and say in their commit what became true |

Machine-wide serial resources: the full Playwright suite, `perf/check.sh` and `proptest/check.sh web` (port 8978).

## Property gate

Moving the harness onto `createSyncSession` changes what the sync property runs: an extra durable-count read before startup, the `ops-skipped` fold, the problem fold, and the session's liveness checks. The sync suite depends on timing, so a seed is not expected to replay the same example before and after; the evidence is the floors, the tally and one mutant.

1. **Before Task 4 merges**, the orchestrator runs `proptest/check.sh web --file sync` on the branch with Task 2 merged and keeps the tally (the property prints it). The floors were measured against the copy.
2. **On Task 4's branch**, `proptest/check.sh web --file sync`. The gate judges every floor. Compare the unfloored labels against step 1 and report the differences as facts.
3. **A floor that fails:** decide first whether the label's path depends on the composition, such as `Edit refused: read-only, mode starting`, which depends on when the mode leaves `starting`. If it does, the floor measured the copy: re-measure by `reach.ts`'s recipe (`PROPTEST_REACH_LOG`, unseeded runs on a quiet machine, the orchestrator's call) and commit the new floor saying why. Never lower a floor without that measurement. If the path does not depend on the composition, it is a finding: investigate before anything else.
4. **Teeth through the session.** The point of W8 is that a bug in the composition is now visible to the property. Apply one uncommitted mutant to `session.ts`: the first connect never runs the reconnect protocol for a replica that has not started (`needsBootstrap` forced `false`). A life that reloads offline then connects keeps an unstarted replica. Run `proptest/check.sh web --file sync --seed <n>` for two seeds; expect a failure (most likely `convergence`) and record which invariant fired. Revert. If neither seed fails, say so: the property does not reach the offline-reload first connect often enough, and that goes to W19 rather than a new rule here. `teeth.prop.ts` keeps its own job: a clean run passes and each broken transport is caught, inside the same `--file sync` run.
5. **Fault warnings:** an `UNEXPECTED` entry in the sync suite's `fault warnings` line is a finding (a recovery path firing where no fault reaches), never an `EXPECTED_KINDS` addition without that reasoning.
6. Final: `proptest/check.sh web` (the whole side) on the final branch.

## Shape left for W9 to W11

- W9 converts sites inside `replicaSync`, `reconnectFlow`, `legacyRepair`, `clientRuntime` and `opQueue`. W8 changes none of their bodies, and builds one reconnect flow per session where `useSocketLifecycle` built one per effect run.
- W10's wiring (`holdsPoison`, `replicaSync.noteUnavailable`, the queue's availability latch telling `replicaSync`, the `outlineRepair` rename) lands in `session.ts` alone, where each part is now built once. Its "`continueStartup` calls `noteUnavailable` instead of `onReplicaState`" removes one of the two `reportMode` callers.
- W11 is inside `replicaSync.runRecovery`.

## Traps

- **A report during render.** The reports are React setters. Building the session must call none, and no part may emit synchronously while being built. Detect: React's "Cannot update a component while rendering" warning in `SyncProvider.test.tsx`; Task 2's "Built" step calls no report.
- **StrictMode builds twice.** In development `useMemo` may run its factory twice and keep one result. The discarded session must start nothing: all work begins at `startup()` and `onSocketStatus`, both reached only from effects. Detect: the StrictMode describe in `SyncProvider.test.tsx`.
- **Liveness, not just disposal.** `isMounted` turns false at cleanup, a microtask before `dispose()`. A listener that checks only `disposed` acts in that gap. Detect: Task 2 `a desync after unmount starts no repair`.
- **The pending count's single writer.** The queue suppresses a re-emit of an unchanged count, so a `pending` report dropped while the session was not live sticks the banner unless something re-reads it. `refreshPending` stays the only door; nothing else calls `report.pending`. Detect: `SyncProvider.test.tsx` § durable batches on connect.
- **Problem identity.** `report.problem` fires only on a new identity, as `applySync` set state only on change; reporting every fold re-renders every health consumer. Detect: `perf/check.sh frontend` render counts.
- **Listener order in the harness.** The harness's `onDesync` and `onPoison` subscribe after the session's, so the session's listener runs first. Both only record; nothing reads the order.
- **Brand rules.** `clientId: ClientId`, `title: RawTitle`, `batchId: BatchId` in every new signature. Detect: `pnpm lint`.
- **FCIS.** `session.ts` is `// pattern: Imperative Shell` and imports no React. Detect: `pnpm check:fcis`; a `react` import in `session.ts` is a review failure.
- **Coverage.** `src/props/**` is excluded, so `session.ts` counts only through `session.test.ts` and the provider tests. Detect: `pnpm test:coverage`.
- **The comment lint judges whole files.** Moved comments are re-judged where they land. Detect: `pnpm lint:comments`.
- **Perf baselines.** The ready-while-disconnected bump no longer costs its own render; a lower render count reads as an improvement, which the check records as a baseline rewrite to commit with the change. Detect: `perf/check.sh frontend`'s table.

## Final gates

| Gate | Who |
|---|---|
| Web gates without Playwright | each implementer, per task |
| `proptest/check.sh web --file sync`, steps 1, 2 and 4 above | orchestrator, serially, around Task 4 |
| `pnpm verify` including the full Playwright suite | orchestrator, after Task 3 merges and on the final branch |
| `proptest/check.sh web` (whole side) | orchestrator, serially, on the final branch |
| `perf/check.sh frontend` | orchestrator, serially, on a quiet machine, on the final branch before merge |

## Questions for Arthur

1. **One `replica-state` event, or two.** Once the fold leaves React, the ready-while-disconnected bump can no longer run in an effect after a render; it runs at the mode report, reading the socket status then. The plan folds it into `replica-state` (which carries `prev`) and deletes `mode-ready-check`, so one event owns every mode rule. The alternative keeps `mode-ready-check` as a second event the session dispatches after each report; the timing change is the same. Recommendation and default: one event.
2. **The session owns the problem fold.** The epic sketched the session emitting events for SyncProvider to fold. The actions need the current problem, and the W19 banner property needs it in the harness, so the plan moves `SyncState` and `transitionSync`'s caller into the session and reports the problem out. Recommendation and default: the session owns it.
3. **`queueHarness.ts` stays hand-wired.** It composes the runtime and the legacy repair around stand-ins for `replicaSync`, the worker and the server, which the queue property steps one command at a time; a session would bring the real `replicaSync` back. Recommendation and default: leave it, with its header naming the session as what it mirrors.
