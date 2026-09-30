# Web Sync Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the web sync layer's ordering, classification and placement rules into Functional Core files, turn the op queue's constructor callbacks into listeners, and give "unusable" one meaning, with no behaviour change.

**Architecture:** Pure cores (`sync/outbox.ts`, `sync/poisonIntents.ts`, `sync/listeners.ts`, `sync/syncFailures.ts`, `replica/placement.ts`) are extracted from the existing shells, which keep their async loops and SQL and compose the cores. `queueState.ts` is the precedent for the core style: plain values in, next value out.

**Tech Stack:** TypeScript, React 19, Vitest, Playwright; the server's pytest reads the shared placement fixture.

**Spec:** `docs/superpowers/specs/2026-09-30-web-sync-extraction-design.md`

## Global Constraints

- No behaviour change. Existing tests take mechanical edits only (constructor arguments become `onX` subscriptions, renamed identifiers). An assertion that has to change: stop and report, do not edit it.
- Every runtime file declares `// pattern: Functional Core` or `// pattern: Imperative Shell`; `pnpm check:fcis` stays green.
- Code and test comments carry no bean ids; a comment states the rule it enforces.
- UI copy is unchanged ("offline editing is unavailable for now" stays).
- The localStorage key stays `pkm.poison-mark-intents.v1`, format `{ version: 1, intents }`.
- Keep both stamping choke points' order: stamp before the optimistic apply (`opQueue.ts` `deferDurableQueue` comment, `replica/queue.ts`).
- `emitPending` stays the only publisher of the pending counts.
- `git diff --no-ext-diff` (difftastic is the configured external diff). Never use port 8974. `git status -sb` before every commit, confirming the branch.
- Commit messages end with `Co-Authored-By: Claude <model> <noreply@anthropic.com>`; never a Claude session URL.
- Web checks: `cd web && pnpm typecheck && pnpm test:unit`; the final task runs `pnpm verify`.

## Review Focus

- The drain and `deliverLaneAhead` delivering the same lane head: one shift, both resolvers settled, the entry behind untouched. Pinned in Task 2.
- A listener subscribed after the triggering call in the same tick (`enqueue` then `onDesync`, `drain` then `onDrain`) still receives the event. Pinned in Task 5.
- A replayed move to a page title that has no page yet: placed, and the page created, as today. Pinned in Task 4.
- StrictMode's replayed effects: a skipped ack bumps resync exactly once, not twice. Pinned in Task 5.
- Poison intents written by the current build are still read after the refactor (same key, same JSON). Pinned in Task 2.

## Branching

Feature branch `feat/pkm-xwb5-sync-extraction` from `main`. Task 1 commits
on it. Tasks 2, 3 and 4 run in parallel worktrees branched from the branch
after Task 1 and merge back `--no-ff`. Task 5 starts after 2 and 3 have
merged. Task 6 is last.

---

### Task 1: One word per meaning for a failed open

**Files:**
- Modify: `web/src/replica/errors.ts`, `web/src/replica/rpc.ts`, `web/src/replica/workerHandlers.ts`, `web/src/sync/opQueue.ts`, `web/src/sync/syncState.ts`, `web/src/sync/retryPolicy.ts`, `web/src/components/OfflineIndicator.tsx`, `web/src/sync/SyncProvider.tsx`, `web/src/sync/replicaSync.ts`, and every test and source file `grep` finds below
- Modify: `docs/architecture/sync-recovery.md`, and any other `docs/architecture/*.md` using these identifiers

**Interfaces:**
- Produces: `class ReplicaUnusableError extends ReplicaError` (`name = "ReplicaUnusableError"`); RPC error shape field `unusable: boolean`; `SyncProblem` kind and `SyncEvent` type `"replica-unusable"`; component `ReplicaUnusableBanner`; `opQueue`'s closure variable `availability: ReplicaAvailability | null`. `ReplicaAvailability` keeps its values `"unusable" | "unreachable"`.

- [ ] **Step 1: Rename**, per the spec's Vocabulary table. The worker latch `let unavailable` in `workerHandlers.ts` becomes `unusable`. Leave unrelated uses of the English word alone (`useStoredPref.ts`, `QueryBlock.tsx`, `keyboardPolicy.ts`, `Settings.tsx`, UI strings).
- [ ] **Step 2: Rewrite the `ReplicaAvailability` doc comment in `errors.ts`.** Drop "availability fact" and "evidentiary levels". Keep the two-row table (value, meaning, retain?, may lift barrier?) and say plainly: retaining an op needs only "this write did not persist locally"; lifting the recovery barrier needs "there is no database", because delivering past an unrepaired rejection is the hazard the barrier guards.
- [ ] **Step 3: Docs.** Invoke the `architecture-docs` skill, then apply the same renames and wording to `docs/architecture/sync-recovery.md` (and any sibling that names these identifiers). Run `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/sync-recovery.md` and fix what it flags.
- [ ] **Step 4: Verify the sweep.**
  Run: `grep -rn "ReplicaUnavailable\|replica-unavailable\|availability fact\|evidentiary" web/src docs/architecture`
  Expected: no output.
  Run: `cd web && pnpm typecheck && pnpm test:unit && pnpm check:fcis`
  Expected: all pass, no assertion edited beyond the renamed strings.
- [ ] **Step 5: Commit** `refactor(pkm-xwb5): unusable is the one name for a failed replica open`.

### Task 2: The ordered-outbox core

**Files:**
- Create: `web/src/sync/outbox.ts`, `web/src/sync/outbox.test.ts`
- Create: `web/src/sync/poisonIntents.ts`, `web/src/sync/poisonIntents.test.ts`
- Create: `web/src/sync/poisonIntentStore.ts`
- Create: `web/src/sync/listeners.ts`, `web/src/sync/listeners.test.ts`
- Modify: `web/src/sync/opQueue.ts`

**Interfaces:**
- Consumes: Task 1's `availability` name in `opQueue.ts`.
- Produces (`outbox.ts`, Functional Core):
  ```ts
  export interface LaneEntry { readonly batchId: string; readonly ops: BlockOp[]; readonly seq: number }
  export interface OutboxState {
    readonly entries: readonly LaneEntry[];
    readonly appended: number;                      // next seq
    readonly follows: ReadonlyMap<string, number>;  // durable batch_id -> lane boundary
  }
  export function createOutbox(): OutboxState
  export function append(s: OutboxState, batchId: string, ops: BlockOp[]): OutboxState
  export function markFollows(s: OutboxState, batchId: string): OutboxState   // no-op when entries is empty
  export function laneHead(s: OutboxState): LaneEntry | undefined
  export function headPrecedes(s: OutboxState, batchId: string | null): boolean
  export function settleHead(s: OutboxState, batchId: string): OutboxState    // shifts only if the head has this batchId; clears follows when the lane empties
  export function forget(s: OutboxState, batchId: string): OutboxState       // follows.delete
  export function clearMarks(s: OutboxState): OutboxState                    // follows.clear
  ```
- Produces (`poisonIntents.ts`, Functional Core): `PoisonEvent` moves here (re-exported from `opQueue.ts` so importers don't change); `validPoisonEvent(value: unknown): value is PoisonEvent`; `parseStoredIntents(raw: string | null | undefined): PoisonEvent[]`; `serialiseIntents(intents: readonly PoisonEvent[]): string`; `withIntent(intents: readonly PoisonEvent[], event: PoisonEvent): PoisonEvent[]`. Deduplication key is `` `${rowId}\u0000${batchId}` ``, last write wins; order is `rowId` then `batchId.localeCompare`.
- Produces (`poisonIntentStore.ts`, Imperative Shell): `readPoisonMarkIntents(): PoisonEvent[]`, `writePoisonMarkIntents(intents: readonly PoisonEvent[]): void`, with today's try/catch behaviour and `removeItem` for an empty list.
- Produces (`listeners.ts`, Functional Core): `export type Listener<T> = (value: T) => void; export function listeners<T>(): { add(fn: Listener<T>): () => void; emit(value: T): void }`, isolating a throwing listener as today.
- Produces (inside `opQueue.ts`): `noteCommitted(ack: OpsAck): OpsAckReading`, the one place the three delivery sites read an ack and call `onSkipped` when it names a skip.

- [ ] **Step 1: Write `outbox.test.ts`.** Tests, each asserting on returned state:
  - `append` assigns `seq` 0, 1, 2 and increments `appended`.
  - `markFollows` on an empty lane returns state with no mark; on a non-empty lane records `appended`.
  - `headPrecedes(s, null)` is true with any head and false on an empty lane.
  - An unmarked batch id: `headPrecedes` is false (the `-1` default).
  - Marked after two entries: `headPrecedes` true until both are settled, then false.
  - `settleHead` with a batch id that is not the head leaves entries unchanged (the double-settle race: settling the same head twice shifts once and leaves the entry behind it in place).
  - `settleHead` emptying the lane clears `follows`.
  - `forget` and `clearMarks` remove marks only.
  - Transitions never mutate their input (compare with a `structuredClone` of `entries` and a copy of `follows`).
- [ ] **Step 2: Write `poisonIntents.test.ts`.** Include a literal string written by the current build, e.g. `JSON.stringify({ version: 1, intents: [{ rowId: 2, batchId: "b", ops: [], status: 400, message: "m" }, { rowId: 1, batchId: "a", ops: [], status: 400, message: "m" }] })`, and assert `parseStoredIntents` returns them sorted by `rowId`. Also: wrong version returns `[]`; malformed JSON returns `[]`; invalid entries dropped; duplicate key keeps the last; `withIntent` replaces a same-key event and keeps sort order; `serialiseIntents` round-trips through `parseStoredIntents`.
- [ ] **Step 3: Write `listeners.test.ts`**: `add` returns an unsubscribe; `emit` reaches every listener; one throwing listener doesn't stop the others.
- [ ] **Step 4: Run them and see them fail** (modules missing). `cd web && pnpm vitest run src/sync/outbox.test.ts src/sync/poisonIntents.test.ts src/sync/listeners.test.ts`.
- [ ] **Step 5: Implement the three cores and the store**, moving code out of `opQueue.ts` with its comments (the `follows` and `laneHeadPrecedes` comments go to `outbox.ts`; the settle-race comment goes to `settleHead`).
- [ ] **Step 6: Rewire `opQueue.ts`.** The closure holds `let outbox = createOutbox()` and a `Map<string, (o: DeliveryOutcome) => void>` of lane resolvers keyed by batch id. `totalPending` and `emitPending` read `outbox.entries.length`. `dispose()` resolves every lane resolver and leaves `outbox.entries` in place. The three ack sites call `noteCommitted`. `createOpQueue`'s signature is unchanged in this task.
- [ ] **Step 7: Verify.** `cd web && pnpm typecheck && pnpm test:unit && pnpm check:fcis`. Expected: all pass with `opQueue.replica.test.ts`, `SyncProvider.test.tsx` and `opsAck.composed.test.ts` untouched.
- [ ] **Step 8: Commit** `refactor(pkm-xwb5): the lane's ordering rules are a pure outbox core`.

### Task 3: Sync failure classifiers

**Files:**
- Create: `web/src/sync/syncFailures.ts`, `web/src/sync/syncFailures.test.ts`
- Modify: `web/src/sync/replicaSync.ts`

**Interfaces:**
- Consumes: Task 1's `ReplicaUnusableError`.
- Produces: `export class PullStarvedError extends Error {}`; `isStallShaped(error: unknown): boolean`; `isWindowFailure(error: unknown): boolean`; `isFreshCorruption(error: unknown, alreadyRebuilt: boolean): boolean`.

- [ ] **Step 1: Write `syncFailures.test.ts`**, table-driven (`test.each`) over: `new ApiError(...)`, `new OfflineError(...)`, `new ReplicaError("x")`, `new ReplicaUnusableError("x")`, `new RpcLifecycleError("timeout", "x")`, `new RpcLifecycleError("disposed", "x")`, `new PullStarvedError("x")`, `new ReplicaError("database disk image is malformed")`, `new TypeError("fetch")`, `new Error("x")`. Expected columns, from today's definitions:
  - `isStallShaped`: true for `ApiError`, `ReplicaError`, the corrupt `ReplicaError`, `PullStarvedError`; false for the rest.
  - `isWindowFailure`: true only for the plain `ReplicaError`.
  - `isFreshCorruption(e, false)`: true only for the corrupt `ReplicaError`; `isFreshCorruption(e, true)`: false for all.
  Check the expected columns against the current code before trusting them. If a cell disagrees with the code, the code wins, and say so in the report.
- [ ] **Step 2: Run it and see it fail** (module missing).
- [ ] **Step 3: Move the three predicates and `PullStarvedError`** with their doc comments. `replicaSync.ts` calls `isFreshCorruption(error, rebuiltForCorruption)` and keeps its `wouldEscalateCorruption` wrapper.
- [ ] **Step 4: Verify.** `cd web && pnpm typecheck && pnpm test:unit && pnpm check:fcis`; `replicaSync.test.ts` untouched.
- [ ] **Step 5: Commit** `refactor(pkm-xwb5): sync failure classifiers are a pure module`.

### Task 4: `placementFor`

**Files:**
- Create: `web/src/replica/placement.ts`, `web/src/replica/placement.test.ts`
- Modify: `web/src/replica/localOps.ts` (`applyOne`, ~l.145-236; the page lookup at ~l.51)
- Modify: `shared/fixtures/missing_targets.json` (`placement_cases`)

**Interfaces:**
- Consumes: `skipsOnMissingTarget` from `replica/missingTarget.ts`.
- Produces:
  ```ts
  export interface PlacementFacts {
    block: { page_id: number; parent_uid: string | null; order_idx: number } | null;
    parent: { page_id: number } | null;
    parentChain: readonly string[];
    titlePageId: number | null;
  }
  export type Placement =
    | { kind: "skip" }
    | { kind: "keep"; repageTo: number | null }
    | { kind: "place"; page: { id: number } | { title: string };
        parentUid: string | null; orderIdx: number; repage: boolean };
  export function placementFor(op: CreateOp | MoveOp, facts: PlacementFacts,
                               reapply: boolean): Placement
  ```
  `localOps.ts` gains `existingLocalPageId(db, title): number | null`, sharing `getOrCreateLocalPage`'s canonicalisation (`canonicalizeTitle` with `plainSpaceTitleCanonicalizationActive(db)`, the `"Untitled"` fallback), never throwing and never creating.

- [ ] **Step 1: Write `placement.test.ts`**, one test per row of the spec's verdict table, plus:
  - a replayed create under its parent that sits on another page → `keep` with `repageTo` = the parent's page;
  - a replayed create whose row has since moved to a different parent → `keep`, `repageTo: null`;
  - a top-level move with `page_title` and `titlePageId: null` → `place` with `page: { title }` and `repage: true`;
  - a replayed top-level move with `page_title` whose `titlePageId` equals the block's page and whose parent and `order_idx` match → `keep`;
  - a move with no parent and no title → `place` on `{ id: block.page_id }`, `repage: false`.
  The page source is `{ title }` whenever the title decides it (only the `keep` comparison reads `titlePageId`), so the shell still calls `getOrCreateLocalPage` exactly where it does today.
- [ ] **Step 2: Run it and see it fail** (module missing).
- [ ] **Step 3: Implement `placementFor`**, and make `applyOne` gather `PlacementFacts` for `create`/`move`, call it, and carry out the verdict (`keepSlot`, `shiftSiblings`, INSERT/UPDATE, the re-page loop, `touchPage`) with today's SQL. For `move`, `titlePageId` is looked up only when `parent_uid` is null and `page_title != null`. Other op kinds keep calling `skipsOnMissingTarget`.
- [ ] **Step 4: Add a fixture row** to `placement_cases`: `"replayed-move-already-at-its-target-keeps-its-slot"`, ops `[{ "op": "move", "uid": "uid_c1", "parent_uid": null, "order_idx": 3 }]`, `"replay": true`, `replica_only: [{ "uid": "uid_c1", "page": "AI", "parent_uid": null, "order_idx": 3 }]`, expect `uid_c1` at `{AI, null, 3}` and `uid_s1` at `{AI, null, 2}`, `pages_absent: []`. Add a row for any other `placementFor` branch the fixture doesn't reach, only where server and web agree without code changes.
- [ ] **Step 5: Verify.**
  Run: `cd web && pnpm typecheck && pnpm test:unit && pnpm check:fcis`
  Run: `cd server && uv run pytest -q tests/test_ops_core.py -k placement`
  Expected: all pass; `localOps.test.ts`, `missingTarget.test.ts`, `applyFkHazards.test.ts` untouched.
- [ ] **Step 6: Commit** `refactor(pkm-xwb5): placementFor decides where a create or move lands`.

### Task 5: Constructor callbacks become listeners

**Files:**
- Modify: `web/src/sync/opQueue.ts`, `web/src/sync/replicaSync.ts`, `web/src/sync/SyncProvider.tsx`, `web/src/sync/useSocketLifecycle.ts`
- Modify (mechanical): `web/src/sync/opQueue.replica.test.ts` (86 `createOpQueue(` calls), `web/src/sync/SyncProvider.test.tsx`, `web/src/sync/opsAck.composed.test.ts`, `web/src/sync/replicaSync.test.ts` (4 `onSkipped` uses), `web/src/sync/useSocketLifecycle.test.ts`

**Interfaces:**
- Consumes: Task 2's `listeners()` and `noteCommitted`; Task 3's module layout of `replicaSync.ts`.
- Produces:
  ```ts
  export function createOpQueue(replica: Replica): OpQueue
  // OpQueue gains:
  onDesync(fn: (error: unknown) => void): () => void;
  onDrain(fn: (outcome: DrainOutcome) => void): () => void;
  onSkipped(fn: () => void): () => void;
  // ReplicaSync gains:
  onSkipped(fn: () => void): () => void;
  ```
  `ReplicaSyncDeps.onSkipped` and `UseSocketLifecycleDeps.drainObserverRef` are removed.

- [ ] **Step 1: Write the timing tests** in `opQueue.replica.test.ts`, each subscribing *after* the call, in the same tick:
  - `q.enqueue(ops)` on a replica whose `enqueue` rejects with `ReplicaError` `rejected: true`, then `q.onDesync(spy)`; after `await q.settled()`, `spy` was called once.
  - `const run = q.drain(); q.onDrain(spy); await run;` → `spy` called once with the outcome.
  - An enqueue whose POST acks a skipped op, then `q.onSkipped(spy)`; after the ticket's `delivered` settles, `spy` was called once.
- [ ] **Step 2: Write the StrictMode test** in `SyncProvider.test.tsx`, beside `describe("ownership and StrictMode lifecycle")`: under `<StrictMode>`, a delivered batch whose ack names a skip bumps the resync count exactly once.
- [ ] **Step 3: Run them and see them fail** (no `onDesync`/`onDrain`/`onSkipped` on `OpQueue`).
- [ ] **Step 4: Convert.** `opQueue.ts` holds `desync`, `drained` and `skipped` listener sets; `drain()`'s observer call and `noteCommitted` emit through them. `replicaSync.ts` exposes `onSkipped` the same way for the recovery flush's ack. `SyncProvider` subscribes `queue.onDesync` and `queue.onSkipped` in the effect that subscribes `onPending`, and `replicaSync.onSkipped` in an effect after the `replicaSync` memo. `useSocketLifecycle` subscribes `queue.onDrain((o) => reconnect.observeDrain(o))` in its effect and unsubscribes in cleanup. Delete `drainObserverRef` and `skippedRef`. Make `repairLegacyRef` a stable `useCallback` if the `retryProblem` path can call it that way; otherwise keep the ref with a comment naming why.
- [ ] **Step 5: Header comment.** State in `opQueue.ts`'s header why no event can precede an effect subscription: every emission follows at least one `await` (persist runs on `persistChain`, delivery waits on a POST), and React runs a commit's passive effects in one synchronous flush.
- [ ] **Step 6: Mechanical test edits.** `createOpQueue(replica, () => undefined)` → `createOpQueue(replica)`; a spy passed as a constructor argument becomes `q.onX(spy)` right after construction. No assertion changes.
- [ ] **Step 7: Verify.** `cd web && pnpm typecheck && pnpm test:unit && pnpm check:fcis`.
  Run: `grep -rn "drainObserverRef\|skippedRef" web/src`
  Expected: no output.
- [ ] **Step 8: Commit** `refactor(pkm-xwb5): the op queue's callbacks are listeners`.

### Task 6: Architecture docs and final verification

**Files:**
- Modify: `docs/architecture/frontend.md` (module map), `docs/architecture/sync-and-offline.md`, `docs/architecture/sync-recovery.md`

- [ ] **Step 1: Invoke the `architecture-docs` skill.** Add the new modules to the `frontend.md` module map. In `sync-and-offline.md`, point the lane-ordering, poison-intent and listener descriptions at the files that now own them. Replace prose that restates `placementFor`'s rules with a link to `replica/placement.ts` and the verdict table's home. Verify each claim against the merged code.
- [ ] **Step 2: Stale counts.** `grep -rn "three constructor\|constructor callback\|onDesync, onDrain" docs/architecture web/src` and fix anything that describes the old shape.
- [ ] **Step 3: Doc check.** `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/frontend.md docs/architecture/sync-and-offline.md docs/architecture/sync-recovery.md` clean.
- [ ] **Step 4: Full verification.** `cd web && pnpm verify` (exit 0); `cd server && uv run pytest -q` (passes). Rerun a failing e2e spec once to check for a known flake and report both runs.
- [ ] **Step 5: Commit** `docs(pkm-xwb5): architecture docs name the extracted sync modules`.

After Task 6 the orchestrator runs `perf/check.sh frontend`, the whole-branch review, and closes pkm-xwb5 and epic pkm-a4t2.
