# pkm-w5gf: Retire frontend legacy queue and test-only transport compatibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the jsdom-only `createLegacyQueue` and every test-double accommodation in the production sync path (optional batch ids, bare-array worker payloads, optional local-API deps), and decompose `runDrain` into named protocols — with zero behavior change to the replica queue's incident-hardened invariants.

**Architecture:** `web/src/sync/opQueue.ts` currently holds two full queue implementations; only the replica-backed one ever runs in a browser. We repoint/retire the legacy-queue tests onto the existing `memReplica()` fake, delete the legacy queue, then make the batch-id and local-API contracts non-optional end-to-end (main thread → RPC → worker → durable row), and finally extract the 4xx-poison and lane-head protocols out of `runDrain` as named functions.

**Tech Stack:** TypeScript, React, Vitest (jsdom), pnpm workspace under `web/`.

**Spec:** `.beans/pkm-w5gf--retire-frontend-legacy-queue-and-test-only-transpo.md` (bean pkm-w5gf), arguing from `docs/2026-08-17-implementation-review-frontend.md` findings A1, B1, and the `runDrain` complexity row. A fact sheet with verified line numbers is at `/private/tmp/claude-501/-Users-arthur-code-llm-pkm/2b140138-8b4f-45ad-b7f4-00edd850a165/scratchpad/w5gf-facts.md` (read it — it is accurate as of branch point 37f5ea8).

## Global Constraints

- Work ONLY in the worktree `/Users/arthur/code/llm/pkm/.worktrees/pkm-w5gf` on branch `pkm-w5gf-legacy-queue`. Run `git status -sb` before every commit and confirm the branch line says `pkm-w5gf-legacy-queue`.
- NEVER edit `web/src/replica/apply.ts` or `web/src/replica/localOps.ts` — a parallel session (bean pkm-t3qw) owns them right now.
- NEVER rename or touch the `"legacy-rejected"` / `"legacy-repair-started|-succeeded|-failed"` vocabulary in `web/src/sync/syncState.ts`, `SyncProvider.tsx`, or their tests. That "legacy" names the desync/repair UI flow shared by the replica queue — it is unrelated to `createLegacyQueue`. Likewise leave server-side "legacy/CLI callers" and "legacy padded rows" doc wording alone.
- Behavior-preservation invariants (each is incident-backed; a regression here is data loss):
  - Fallback-lane FIFO ordering behind durable rows (`durableAhead` / `durableSinceFallback` accounting, pkm-49eh, pkm-yavj).
  - Poison-mark intent retention in localStorage (`pkm.poison-mark-intents.v1`) and the queue starting in `recovering` when intents exist (`createQueueState(intents.length > 0)`, opQueue.ts:172). This is the pkm-tu5k gate: it must remain byte-for-byte semantics-identical. pkm-tu5k reconciliation = do not change this mechanism at all.
  - `onUnsentInMemory` always emits `fallback.length` (never the durable pending count) — it feeds the `beforeunload` guard (pkm-0htf).
  - Batch ids are minted main-thread BEFORE the enqueue RPC and shared with the lane copy (pkm-ybgt).
  - A 4xx on a durable batch runs the ordered protocol: `pause → poisonPending.emit → rememberPoisonMark → finishDelivery → (first rejection only) durableBatchSettled → markRetainedPoison`.
  - The one-failed-open latch: `noteReplicaFailure` only latches on `isSessionFatal`; nothing new may re-arm a dead replica (pkm-9x6u).
- Every code file keeps its `// pattern: ...` FCIS header.
- Verification gates per task: `cd web && pnpm typecheck && pnpm test:unit`. Coverage thresholds (95/91/89/95) are enforced by `pnpm test:coverage` — run it in Task 1 and Task 5 (they move the most lines). Full `pnpm verify` runs once, in Task 5 (set `CI=true`).
- Commits: conventional style, include changed bean/plan files where noted, `Co-Authored-By: Claude ...` OK, NEVER a `Claude-Session:` trailer or claude.ai URL (a commit-msg hook rejects it).
- Do not dispatch subagents from implementer sessions.

---

### Task 1: Retire `createLegacyQueue` and repoint its test coverage at the fake Replica

**Files:**
- Modify: `web/src/sync/opQueue.ts` (delete :730-942 `createLegacyQueue`, :17 `MAX_BATCH`; rewrite `createOpQueue` :944-950)
- Modify: `web/src/sync/opQueue.replica.test.ts` (import shared fake; receive ported tests)
- Delete: `web/src/sync/opQueue.test.ts`
- Create: `web/src/sync/memReplica.ts` (the shared fake, moved out of opQueue.replica.test.ts:19-60)
- Modify: `web/src/sync/SyncProvider.tsx` (non-null replica for `createOpQueue`)
- Modify: `web/src/sync/queueState.ts` (:3 comment says "legacy in-memory queues" plural — now singular)
- Possibly modify: `web/src/sync/SyncProvider.test.tsx` and any other test that renders `<SyncProvider>` without a `replica` prop
- Possibly modify: `web/vite.config.ts` (coverage `exclude` list gains `src/sync/memReplica.ts` ONLY if the coverage run demands it; prefer leaving it counted since tests execute it)

**Interfaces:**
- Produces: `createOpQueue(replica: Replica, onDesync, onDrain?)` — first parameter non-nullable. Later tasks rely on this signature.
- Produces: `export function memReplica(over: Partial<Replica> = {}): Replica & { rows: PendingBatch[]; enqueued: string[] }` in `web/src/sync/memReplica.ts` — body identical to the current opQueue.replica.test.ts:19-60 definition (move, don't rewrite).

**Steps:**

- [ ] **Step 1: Move `memReplica` to `web/src/sync/memReplica.ts`.** Copy lines 19-60 of opQueue.replica.test.ts verbatim into the new file with the needed imports (`Replica`, `PendingBatch` from `../replica/client`), export it, and add a header comment `// Test fake: in-memory Replica mirroring queue.ts semantics. Not shipped — imported only by tests.` Update opQueue.replica.test.ts to import it. Run `cd web && pnpm test:unit -- opQueue` — all existing tests must stay green.

- [ ] **Step 2: Build the disposition table for the 21 tests in `opQueue.test.ts`.** For each test decide one of: **(a) DELETE-covered** — an existing test in opQueue.replica.test.ts pins the same policy (name it); **(b) DELETE-legacy-only** — the behavior belongs to the legacy queue's mechanism (`MAX_BATCH` reslicing, frozen-slice retry replay, legacy ticket semantics) and has no replica-queue analogue by design; **(c) PORT** — a queue POLICY (connectivity, barrier, missed-kick, backoff, dispose) not yet pinned for the replica queue. Starting expectation (verify each against the actual replica test file before trusting it):
  - Expected (b) DELETE-legacy-only: `batches larger than 500 ops split...` (:223), `legacy 4xx fails only tickets touched...` (:270), `legacy queue sends a batch_id and freezes the slice...` (:333), `ops enqueued in the same tick coalesce...` (:25), `legacy offline enqueue settles in memory...` (:234), `legacy write ticket reports delivery only after...` (:250).
  - Expected (a) DELETE-covered: offline no-HTTP (:133), reconnect flush order (:144), 503 retry 250ms (:312), terminal-state `test.each` (:450), in-flight → next batch (:38), failed batch reports desync (:58).
  - Expected (c) PORT candidates (port only if genuinely uncovered): onDesync re-enqueue not stranded (:75), async resume hands missed kick (:90), throwing onDesync doesn't poison drain (:116), in-flight POST completes after offline (:156), missed kick barred by recovery (:180), dispose drops missed kick (:203), missed kick doesn't bypass backoff (:365), dispose cancels retry (:400), reconnect resets retry delay (:422).
  Record the final table (test name → disposition → covering-test name or new-test name) in your report file. Every one of the 21 must appear.

- [ ] **Step 3: Write the ported tests (red first where possible).** Add each PORT test to opQueue.replica.test.ts using `memReplica()` + the file's existing `fetchSeq` helper, following the file's existing style. Example port for `a throwing onDesync does not poison the queue or drain()`:

  ```ts
  test("a throwing onDesync does not poison the queue or drain()", async () => {
    const replica = memReplica();
    const { calls } = fetchSeq([
      () => new Response("bad", { status: 400 }),
      () => jsonResponse({}),
    ]);
    const queue = createOpQueue(replica, () => { throw new Error("boom"); });
    queue.enqueue([op("a")]);
    await queue.settled();
    const first = await queue.drain();
    expect(first).toMatchObject({ status: "blocked", reason: "recovering" });
    // The throw was isolated: an explicit resume still drains later work.
    queue.resume("recovery");
    queue.enqueue([op("b")]);
    await queue.settled();
    const second = await queue.drain();
    expect(second).toMatchObject({ status: "drained" });
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
  ```

  Adapt assertions to what the replica queue actually promises (e.g. a 4xx here poisons the durable row and retains the intent — assert via `replica.rows` / `queue.poisonMarkIntents()` where the legacy test asserted in-memory state). These run green against the CURRENT queue (the replica queue already implements the policies) — that is expected; the point is pinning coverage before the deletion.

- [ ] **Step 4: Run the new tests.** `cd web && pnpm test:unit -- opQueue.replica` — all green, including ports.

- [ ] **Step 5: Delete the legacy queue.** In opQueue.ts remove `createLegacyQueue` (:730-942), `MAX_BATCH` (:17), and rewrite the factory:

  ```ts
  export function createOpQueue(replica: Replica,
                                onDesync: (error: unknown) => void,
                                onDrain: (outcome: DrainOutcome) => void =
                                  () => undefined): OpQueue {
    return createReplicaQueue(replica, onDesync, onDrain);
  }
  ```

  Delete `web/src/sync/opQueue.test.ts`. Update the queueState.ts:3 comment ("legacy in-memory queues" → the single replica-backed queue). Keep `createReplicaQueue` itself untouched in this task.

- [ ] **Step 6: Fix the SyncProvider seam.** `SyncProvider.tsx:194` currently calls `createOpQueue(replicaRef.current ?? null, ...)`. Grep every test that renders `<SyncProvider` (SyncProvider.test.tsx and any component test): if all pass a `replica` prop, change the provider so a missing replica is a hard error — in the `replicaRef` initialization (:183-192), when the prop is absent AND `defaultReplica()` returns null, `throw new Error("SyncProvider requires a Replica: pass the replica prop in tests (jsdom has no Worker)")` — and drop the `?? null`. If any test renders it bare, give that test `memReplica()` via the prop instead of weakening the provider. Do not change production wiring (`App.tsx` renders bare `<SyncProvider>`; a real browser always has `Worker`).

- [ ] **Step 7: Full gate.** `cd web && pnpm typecheck && pnpm test:unit && pnpm test:coverage` — thresholds (95/91/89/95) must pass. If coverage newly fails on `memReplica.ts` lines, prefer covering them via tests you control; only as a last resort add it to the vite.config.ts coverage `exclude` (it is a test fake, same footing as the excluded `src/test-helpers.ts`), and say so in the report.

- [ ] **Step 8: Commit.** `git add -A web/src docs/superpowers/plans web/vite.config.ts` (as applicable), commit: `refactor(sync): retire createLegacyQueue; queue policy tests ride the fake Replica (pkm-w5gf)`.

### Task 2: Make enqueue batch ids required end-to-end; delete unidentified-delivery bookkeeping

**Files:**
- Modify: `web/src/replica/client.ts` (:63-65 `enqueue` signature; keep the pkm-ybgt comment)
- Modify: `web/src/replica/queue.ts` (:27 return type, :70 conditional spread — `batchId` returned unconditionally)
- Modify: `web/src/replica/workerHandlers.ts` (:162-177 enqueue handler object-only; :186-201 `markPoisoned` payload `batchId` required)
- Modify: `web/src/sync/opQueue.ts` (delete `unidentifiedDeliveries` :184-187, `finishObservedUnidentified` :248-257, its two call sites :482 :510, the `result.batchId === undefined` branch :613-617, and the loop in `finishAllDeliveries` :243-245)
- Modify: `web/src/sync/memReplica.ts` (enqueue `batchId` param non-optional; drop the `?? \`batch-${nextId}\`` fallback)
- Modify: `web/src/sync/opQueue.replica.test.ts` (delete the two "unkeyed" tests at :497 and :526 — their premise, a replica that returns no batch id, no longer type-checks)
- Modify: `web/src/replica/workerHandlers.test.ts` (bare-array enqueue calls → object shape; markPoisoned payloads gain batchId where omitted)

**Interfaces:**
- Consumes: `createOpQueue(replica: Replica, ...)` from Task 1.
- Produces: `Replica.enqueue(ops: BlockOp[], batchId: string): Promise<{ pending: number; batchId: string }>`; worker `enqueue` handler payload exactly `{ ops: BlockOp[]; batchId: string }`; `markPoisoned` payload exactly `{ id: number; error: string; batchId: string }`.

**Steps:**

- [ ] **Step 1: Red.** Change `Replica.enqueue` in client.ts to `enqueue(ops: BlockOp[], batchId: string): Promise<{ pending: number; batchId: string }>` (update the doc comment: the caller ALWAYS mints the id — keep the pkm-ybgt lost-reply rationale, drop the "Omitted => the worker mints one" sentence). Run `pnpm typecheck` — expect failures at memReplica, opQueue.ts:613, and the two unkeyed tests. That failure list is the checklist for this task.

- [ ] **Step 2: Worker side.** In workerHandlers.ts `enqueue` (:162-177): delete the `Array.isArray` branch and its "older bundles" comment; destructure `const { ops, batchId } = payload as { ops: BlockOp[]; batchId: string };` and call `enqueueBatch(d, ops, nowMs(), batchId)`. In `markPoisoned` (:186-201): make `batchId` required in the payload type and drop its "older direct handler callers" tolerance (opQueue.ts:343-345 always sends it; no bundle skew is possible — worker and main bundle ship from one hashed build). Keep `newBatchId` in WorkerDeps — the localApi router still consumes it.

- [ ] **Step 3: Durable layer.** In queue.ts make `enqueueBatch`'s return include `batchId` unconditionally (delete the `...(ops.length > 0 ? { batchId } : {})` spread and the `batchId?` in the return type) — opQueue.ts:580-584 already short-circuits empty enqueues before the RPC, and the localApi caller passes a real id.

- [ ] **Step 4: Queue bookkeeping deletion.** In opQueue.ts delete `unidentifiedDeliveries`, `finishObservedUnidentified`, both call sites, and the undefined-batchId branch in the persist closure (:609-620 becomes: disposed check, then `deliveries.set(result.batchId, resolveDelivery)`). In `finishAllDeliveries` delete the unidentified drain loop. KEEP the `pendingCount === 0 → finishAllDeliveries` block at :512-516 but rewrite its comment: the remaining reason is rows deleted outside the drain (a recovery flush/rebase) whose tickets must settle as delivered once the durable queue is observed empty. Keep the `batch === null` branch (:448-461) untouched.

- [ ] **Step 5: Tests.** Update memReplica (`batchId: string` param, no fallback mint). Delete the two unkeyed tests (:497, :526) — note in the report they are deleted because their premise (a batch-id-less reply) is now unrepresentable in the type system, which is the point of the change. Fix workerHandlers.test.ts call sites to the object shape. Verify the pkm-ybgt test (`a lost-reply enqueue retains the lane copy under the durable row's batch id`, :427) still passes unmodified — it is the load-bearing proof for this contract.

- [ ] **Step 6: Gate.** `cd web && pnpm typecheck && pnpm test:unit`. Expected: green, with exactly the deleted tests gone.

- [ ] **Step 7: Commit.** `refactor(replica): enqueue batch ids are required end-to-end; drop unidentified-delivery FIFO (pkm-w5gf)`.

### Task 3: Local API deps become required; delete the dead re-export

**Files:**
- Modify: `web/src/replica/localApi/router.ts` (:46-47 signature `deps: LocalApiDeps`; :93 drop `&& deps` from the guard; :148 delete `export { escapeFtsQuery, titleForDate };` — KEEP the imports at :9/:15 only if still used elsewhere in the file; `titleForDate` and `escapeFtsQuery` are both used internally by the routes, so check each before removing an import)
- Modify: `web/src/replica/localApi/router.test.ts` (delete the `POST /api/pages without deps is not handled` test at :48; every remaining direct call passes `{ newBatchId: ... }`)
- Modify: `web/src/replica/localApi/parity.test.ts` (pass deps at direct `handleLocalApi` call sites that omit it)
- Check-only: `web/src/replica/workerHandlers.ts:252-254` already always passes `{ newBatchId }` — no change

**Interfaces:**
- Produces: `handleLocalApi(db: ReplicaDb, req: LocalApiRequest, deps: LocalApiDeps): LocalApiResult` — third parameter required.

**Steps:**

- [ ] **Step 1: Red.** Make `deps` required in the signature; `pnpm typecheck` — the failure list enumerates every test call site to fix.
- [ ] **Step 2: Green.** Drop `&& deps` from the `POST /api/pages` guard. Fix test call sites to pass `{ newBatchId: () => "batch-test-1" }` (or the file's existing convention). Delete the without-deps test — its behavior (silent NOT_HANDLED degrade) is exactly the failure mode the bean retires; a future caller forgetting deps is now a compile error, which is strictly stronger than the test was.
- [ ] **Step 3: Dead re-export.** Delete router.ts:148. Verify with `grep -rn "from \"./localApi/router\"\|from \"../localApi/router\"" web/src | grep -v "LocalApiRequest\|LocalApiResult"` that nothing imported the two names via router. Keep imports at :9/:15 only if the file body still uses them (it does — the daily/FTS routes); confirm by grep within the file.
- [ ] **Step 4: Gate + commit.** `cd web && pnpm typecheck && pnpm test:unit`. Commit: `refactor(replica): localApi deps are required; drop dead router re-export (pkm-w5gf)`.

### Task 4: Extract named protocols from `runDrain`; rename the side-effecting `laneOnly`

**Files:**
- Modify: `web/src/sync/opQueue.ts` only (within `createReplicaQueue`)

**Interfaces:**
- Consumes: the post-Task-2 `runDrain` (unidentified bookkeeping already gone).
- Produces: no external interface change whatsoever. `OpQueue` surface, event ordering, and every observable behavior stay identical. This task is REFACTOR-ONLY: no test may need modification, and no new tests are required (the 51+ replica tests are the harness).

**Steps:**

- [ ] **Step 1: Extract `deliverLaneHead`.** Pull the lane-head branch (today :405-432, post-Task-2 numbering will differ) into a closure `const deliverLaneHead = async (head: FallbackEntry): Promise<DrainOutcome | null> => { ... }` returning `null` for "delivered, keep looping" and a `DrainOutcome` to return. Move the branch's comments with it verbatim.
- [ ] **Step 2: Extract `rejectDurableBatch`.** Pull the durable 4xx protocol (today :466-498) into `const rejectDurableBatch = async (batch: PendingBatch, error: ApiError): Promise<DrainOutcome> => { ... }`. The ordering comments (pause → poisonPending → rememberPoisonMark → finishDelivery → durableBatchSettled-once → markRetainedPoison) move with the code — they are the protocol's spec; do not thin them.
- [ ] **Step 3: Rename `laneOnly`.** Split the side effect from the decision: `const clearDurablePrecedence = (): void => { for (const entry of fallback) entry.durableAhead = 0; durableSinceFallback = 0; };` and a caller-side decision that keeps the exact same control flow at both call sites (:434, :444) and the `batch === null` branch (:457-458) which performs the same clearing — route all three through `clearDurablePrecedence()`. Preserve the big lane-only doc comment (:374-393) attached to wherever the decision now lives.
- [ ] **Step 4: Gate.** `cd web && pnpm test:unit -- opQueue.replica && pnpm typecheck`. Then run the FULL unit suite once (`pnpm test:unit`) — refactors here have historically broken SyncProvider tests via subtle timing, and the suite is the only detector.
- [ ] **Step 5: Commit.** `refactor(sync): name runDrain's lane-head and 4xx-poison protocols (pkm-w5gf)`.

### Task 5: Docs, bean closure, full verification gate

**Files:**
- Check/modify: `docs/architecture/sync-and-offline.md` (fact sheet says it never names the legacy queue — verify "Key pieces" (:28) and "An online edit, end to end" (:42) carry no two-implementations framing; update the enqueue contract wording if it hedges on optional batch ids)
- Check/modify: `docs/architecture/frontend.md` (module map: if it names `opQueue.test.ts` or describes two queues, fix)
- Modify: `.beans/pkm-w5gf--retire-frontend-legacy-queue-and-test-only-transpo.md` (tick acceptance criteria; add `## Summary of Changes`; record the pkm-tu5k reconciliation: the poison-intent gate and its localStorage mechanism were not modified; record that Replica enqueue/markPoisoned/localApi contracts are now compile-time-required)
- Modify: this plan file (tick remaining checkboxes)

**Steps:**

- [ ] **Step 1: Docs pass.** Invoke the `architecture-docs` skill before editing anything under docs/architecture/. Grep both docs for `legacy`, `MAX_BATCH`, `unidentified`, `opQueue.test` and fix only what is now wrong. Docs-only edits need no test run, but this task also owns the final gate below.
- [ ] **Step 2: Bean update.** Tick every satisfied acceptance criterion checkbox; the "Reconcile with pkm-tu5k" criterion is satisfied by the Global Constraints note (gate untouched) — say so explicitly in the bean.
- [ ] **Step 3: Full gate.** From the worktree root: `cd web && CI=true pnpm verify` (typecheck, lint, FCIS check, coverage-enforced unit tests, vite build, Playwright e2e). Also `pnpm build` happens inside verify. Paste the tail of the output in the report. Known flakes: see the repo's e2e conventions — a load-sensitive flake may be retried once, but report it.
- [ ] **Step 4: Commit.** `docs(pkm-w5gf): close out legacy-queue retirement — docs + bean` including bean + plan + doc files.

---

## Self-review notes (author)

- Spec coverage: bean criteria → Task 1 (tests-at-fake-Replica, delete legacy queue + dispatcher + MAX_BATCH), Task 2 (required batch ids, no unidentified FIFO, object-only worker payload), Task 3 (required deps — the bean's either/or resolved to "required" since production always supplies them), Task 4 (runDrain protocols + laneOnly rename), Task 5 (docs + full web gate); "preserve …with regression tests" is carried by Task 1's ported-policy tests plus the untouched 51-test replica suite; "reconcile pkm-tu5k" is a Global Constraint plus a bean note.
- Type consistency: `memReplica` signature defined in Task 1 and consumed in Task 2; `createOpQueue(replica: Replica, ...)` defined in Task 1, consumed by Task 2's opQueue edits.
- Known judgment points left to implementers deliberately: exact disposition of each of the 21 legacy tests (table required in report), whether coverage needs a vite.config exclude for memReplica.ts (last resort), SyncProvider bare-render tests (procedure given).
