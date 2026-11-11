# W10 Sync Poison Claim, Mode Writer, Leased Delivery: Task-Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Implementers work under the epic's implementer brief; this plan does not restate it.

**Goal:** Three rules that each live in two places today get one owner. The poison repair's claim on recovery becomes the queue barrier's `poison` claim, read through `OpQueue.holds`, instead of a flag in `replicaSync` that a discard can clear while the repair still runs. Replica mode and `usable` get one writer, `replicaSync.noteUnavailable`, which the queue's availability latch also reaches. The recovery flush posts through `OpQueue.deliverLeased`, so every `/api/ops` POST and every skipped-op signal belongs to the queue. The legacy outline repair is renamed to what it is, the outline repair.

**Architecture:** The barrier in `queueState.ts` is already the one record of who holds delivery. W10 makes it the record `replicaSync` reads too: `holdsPoison: () => queue.holds("poison")`, and the queue's `onRelease` listener pays the pull a poison repair left owed. `clientRuntime` becomes the only code that releases `poison`. `replicaSync` owns replica mode and `usable` behind one door that drops every report after `no-replica`. The queue owns delivery: the drain, the lane and the recovery flush's leased batches.

**Tech stack:** TypeScript, vitest + jsdom, fast-check (`web/src/props/gate.ts`), the queue and sync property suites (`proptest/check.sh web --file sync`).

**Source:** `docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md` § W10, with its Global Constraints and Review Focus. Branch `refactor/sync-poison-mode`, read at `d7fd284d` (W8 and W9 merged). W11 follows on `replicaSync.runRecovery`.

## Global Constraints

The epic's Global Constraints apply unchanged. The ones that bite here:

- Web verification for implementers is the web gates without Playwright: `cd web && pnpm typecheck && pnpm lint && pnpm lint:comments && pnpm check:fcis && pnpm test:coverage && pnpm build` (all with `--config.verify-deps-before-run=false`; never `pnpm add/install/update`, `node_modules` is a symlink).
- `pnpm verify`, `perf/check.sh frontend` and `proptest/check.sh web` are the orchestrator's, run serially. The sync suites need the server `proptest/check.sh` starts on port 8978, so no implementer runs them.
- Standing rulings: do not fold `usable` into `ReplicaState`; do not change `OpsAck.applied`; no phase union in `socket.ts`; the replay budget stays.
- Converted machines: the poison claim (a flag made a read of the barrier) and replica mode (one writer). Both touch machines an existing suite covers, so W10 updates `queueModel.ts` and `oracle.ts`'s `ModeWatch` in this branch and adds what no suite reaches to W19.
- Tests that W10's seam changes break are **ported**: their setup changes (a fake gains `holds`, loses `completeAuthoritativeRepair`; a recorded call list loses the call that no longer exists), their assertions about behaviour do not. Each task names them. An implementer who finds a behavioural assertion failing reports it with the failure; editing it is a review failure.
- Comments: no bean ids, line numbers or plan pointers; 80 columns in comments; AGENTS.md's banned word stays out. Docs under `docs/architecture/` go through the `architecture-docs` skill.

## Review Focus

Failure modes no single task's tests are certain to exercise, most likely first.

1. **One claimant's release lifting another's poison claim.** The barrier is a set: a second `pause("poison")` adds nothing, so the first `resume("poison")` frees every claimant. Every releaser therefore checks that no repair is running. Pinned by Task 3's epic test and the unmatched-round tests.
2. **The owed pull paid late or never.** `payPoisonPull` moves from `completeAuthoritativeRepair` to the queue's release of `poison`. A release path that skips `resume` (a repair succeeding while not live) now also skips the pull. Pinned by the ported "work left to a poison repair is pulled again once the repair releases recovery"; the liveness case is Finding B.
3. **A report after `no-replica`.** An owed pull, a `start()`, or `runRecovery`'s catch reporting after the replica is gone puts the stalled banner and its futile Reset over the online-only banner. Task 4's red tests.
4. **A leased POST past a claim that landed during lane-ahead.** `flushBatches` checks the poison claim twice per batch, before and after `deliverLaneAhead`. The second check moves inside `deliverLeased`. Task 5 `deliverLeased checks beforePost after the lane ahead and posts nothing when it throws`.
5. **A skipped-op bump lost or doubled** when the recovery flush's and the payload's signals move from `replicaSync.onSkipped` to the queue's `onSkipped`. Task 5's session test.

---

## Premise checks: where the code disagrees with W10

The code wins in each case; the tasks are written to the code.

| W10 (or an earlier plan) says | The code says | What the plan does |
|---|---|---|
| Delete `authoritativeRepair`, `onPoisonPending`, `completeAuthoritativeRepair` | A third hook, `onPoisonMarkUnmatched`, is subscribed by `replicaSync`, which then calls `queue.resume("poison")` itself, whether or not a repair holds the claim. `clientRuntime.discardPoisonIntents` calls `completeAuthoritativeRepair` unconditionally, mid-repair included | `replicaSync` stops touching `poison`. The unmatched release moves to `clientRuntime` under the discard's rule: only once discovery has answered and no repair runs (Task 3) |
| `payPoisonPull` runs "on the queue's resume of `poison`" | The queue has no such signal. `opQueue.ts`'s header says no method may emit synchronously; `resume()` is called synchronously by its owners | New `OpQueue.onRelease(fn: (owner: BarrierOwner) => void)`, fired by `resume` when it released a held claim, after the release. The header's rule is restated to what it protects (Question 1) |
| `holdsPoison` is the old flag under a new name | The queue holds `poison` from construction when a reload left mark intents; the flag was set only by `onPoisonPending` or `rebaseAuthoritative`. If startup marking keeps failing, the first connect still runs `replicaSync.start()`, and a pass that needs a recovery today runs a normal rebase whose flush posts past the unmarked rejected row | Accepted as the intended behaviour: the claim covers the retained intents too. Pinned by Task 3 `a connect while a reload's poison mark keeps failing leaves recovery to the poison claim` (Question 4) |
| `noteUnavailable(error: ReplicaError)` | A dead worker's error is `RpcLifecycleError`, which is not a `ReplicaError`; `isSessionFatal` accepts it and `ReplicaUnusableError` | `noteUnavailable(error: SessionFatalError)`, with `type SessionFatalError = ReplicaUnusableError \| RpcLifecycleError` in `replica/errors.ts` |
| `continueStartup` calls `noteUnavailable` instead of `onReplicaState` | It also emits a separate `replica-unusable` sync event, because its `no-replica` report carries no error and so raises no banner. `replicaSync.usable` stays true, so `appliedVersion()` answers a number for a replica startup found unusable | One report with the error raises the banner; the `replica-unusable` sync event goes (W8 left it for this). `usable` turns false at discovery |
| `error` on `no-replica` becomes required | The session's no-replica-environment report (`runtime === null`) has no error and raises no banner. jsdom (`Worker` undefined) and `replica={null}` reach it, in `SyncProvider.test.tsx`, `session.test.ts`, `syncSlices.test.tsx`, `useSocketLifecycle.test.ts` and `EditablePage.churn.test.tsx` among others | The session reports `absentReplica()`'s message; the online-only banner then shows there too (Question 2) |
| Drop "Nothing reports the death…" once it is false | With the latch wired, the death is still reported only at the next replica call; that call may now be the queue's (an edit, a drain) as well as `replicaSync`'s | Task 7 rewrites the sentence instead of dropping it |
| (not in W10) | A recovery that meets a dead worker reports `recovery-failed` and then `no-replica` in one pass. `replicaUnusable` never replaces another problem, so the stalled banner and its Reset stay over a dead replica. Reproduced on this branch with a scratch test: states `ready, recovery-failed, no-replica`, problem `replica-stalled`. A stall reported before a worker dies ends the same way | Fixed in Task 4: `no-replica` is terminal, `runRecovery` leaves a session-fatal error to `noteUnavailable`, and `replica-unusable` replaces `replica-stalled` (Question 5) |
| `OpQueue.deliverLeased(batch): Promise<OpsAckReading>` | `flushBatches` runs its `beforePost` guard twice per batch, before and after `deliverLaneAhead`, because the lane ahead can take a while and a poison claim may land during it | `deliverLeased(batch: PendingBatch, beforePost: () => void)`; it calls `beforePost` between the lane ahead and the POST |
| `flushBatches` loses its `onSkipped` | `settleApplied` also emits `replicaSync.onSkipped`, for a payload's applied batches whose stored ack skipped an op | `settleCommitted` takes each batch's `skipped` and emits the queue's `onSkipped`; `replicaSync.onSkipped`, its listener set and the session's second subscription go |
| (not in W10) | The flush posts through `fetchJson` + `opsAckOfWire`; the queue through `post` (`apiPost`). Both reach `apiFetch`; the sync harness sends both through one transport. `ReplicaSyncDeps.clientId` has no use left once the body builder goes | No behaviour difference. `clientId` leaves `ReplicaSyncDeps` in a separate mechanical commit (Task 5). `opsAckOfWire` keeps only `opsAck.test.ts`; it stays as that test's parser |
| `deliverLaneAhead` is unmentioned | Its one caller is `flushBatches` | It leaves the `OpQueue` interface; `deliverLeased` is the flush's one door. Its six tests port to `deliverLeased` |
| W9: `orderedPoisonEvents` replaces `mergePoisonEvents` "in three places" | Four call sites in `clientRuntime.ts` (`runRepair`, `repairOnce`'s `merge`, `repair`, `continueStartup`); `poisonIntents.ts::ordered` is the same function | All four; `ordered` is exported under the new name |
| `readPendingRows(db, after?: number)` | Row ids are `PendingRowId`. `salvagePendingRows` reads one row past `after` at a time, so a damaged row stops the walk with the prefix intact; `readDurablePendingRows` and `carryStore.read` read every row. Each caller keeps its own table-existence check | `readPendingRows(db, after?: PendingRowId)`: no `after`, every row in id order; with `after`, at most the next one |
| Delete `poisonDetails`'s display-string fallback | `pending_ops.error` is persisted. Rows marked before `389f34a8` (2026-07-15) hold the display string; later ones hold `{status, message}` JSON. Startup discovery repairs and deletes every poisoned row at each load with a usable replica, so only a profile not opened with a working replica since July can hold one | The regex parse of `request failed: NNN` goes; an `error` that is not the JSON shape reads `{ status: 400, message: "rejected batch from a previous session" }`, as a null one does. It must never throw: discovery has to answer |
| Delete plan-pointer comments `Task N`, `Fix A`, `su05` | Only `su05` remains, in `replica/client.ts`'s `enqueue` doc | Delete that one |
| Delete the three quota tombstone comments | `replica/errors.ts` (`ReplicaError`'s doc), `opQueue.ts` (`enqueue`'s catch), `syncState.ts` (`computeEditability`'s doc). `sync-recovery.md` § A local write fails already states the fact they carry | Delete all three |
| Rename `legacy-rejected`, `legacy-repair-*`, `legacyBehind`, `legacyRepair.ts` | The concept also names `LegacyRepair`/`createLegacyRepair`, `retryPolicy`'s `legacy-repair` plan kind, `OfflineIndicator`'s `LegacyRejected*` components, the queue suite's `legacyStable`/`legacyFails`/`legacyDone` commands and its `legacy …` tally labels, which are floor keys in `queue.prop.ts` | All in Task 1's one commit; label keys move with their labels and keep their values. "Legacy" meaning old data (a legacy nest, a legacy stored heading) is untouched |
| The offline gateway (W8 note) | `SyncProvider`'s gateway reads the mode from `modeRef`, written during render, so it lags a mode report by one render. W8 kept it so a ready-while-disconnected bump and the mode reach views in one render | Left as it is (Question 3) |
| `harnessClient.poisonOwns` (not in W10) | Derives "poison owns recovery" from the runtime's events: a copy of the claim rule | Reads `session.queue.holds("poison")` (Task 3) |
| `proptest/check.sh --file sync` | `--file` is web only | `proptest/check.sh web --file sync` |

## The poison claim: ownership before and after

Today two records claim recovery for the poison repair, and they disagree in three places.

**Before.**

| Record | Claimed by | Released by | A second claimant gets |
|---|---|---|---|
| queue barrier `poison` | the queue's construction when a reload retained mark intents; `rejectDurableBatch`; `markRetainedPoison`; `clientRuntime.runRepair` | `runRepair` on success (when live); `continueStartup` (unusable replica, or nothing poisoned); `discardPoisonIntents` when no repair runs; `replicaSync`'s unmatched listener when its own flag is set, even while a repair runs | nothing new: the set already holds `poison`, and the first release frees it for every claimant |
| `replicaSync.authoritativeRepair` | `onPoisonPending` (inside `rejectDurableBatch`, after the pause); `rebaseAuthoritative` | the unmatched listener; `completeAuthoritativeRepair`, called by `runRepair` on success (live or not) and by `discardPoisonIntents` always | the same flag |

Disagreements: a discard while a repair runs clears the flag and keeps the barrier; a repair succeeding while not live clears the flag and keeps the barrier; a reload's retained intents hold the barrier and not the flag.

**After.** One record.

| Record | Claimed by | Released by | A second claimant gets |
|---|---|---|---|
| queue barrier `poison`, read by `replicaSync` as `holdsPoison()` | unchanged: construction with retained intents; `rejectDurableBatch`; `markRetainedPoison`; `runRepair` | `clientRuntime` only: `runRepair` on success (when live); `continueStartup`'s two branches; `discardPoisonIntents` when no repair runs; an unmatched marking round when discovery has answered and no repair runs | nothing new, so every releaser checks `repairOnce.running()` (startup's branches run before any repair) |

A release fires `onRelease("poison")`; `replicaSync` pays the owed pull there. `startup`, `recovery` and `lane` are unchanged.

**Interleavings the red tests cover:**

1. A discard while a repair runs keeps the claim until the repair ends (the epic's test, Task 3).
2. The same, composed: a pass needing recovery, and a manual reset, during that repair wait for it (Task 3, `barrier.test.ts`).
3. A connect while a reload's mark keeps failing: the pass leaves recovery to the claim (Task 3, `session.test.ts`).
4. An unmatched marking round mid-session with no repair: releases and pays the owed pull (ported from `replicaSync.test.ts`, owner now `clientRuntime`).
5. An unmatched round while a repair runs keeps the claim (new, `clientRuntime.test.ts`).
6. An unmatched round during startup discovery leaves the release to `continueStartup` (new guard).
7. A rejection landing while a normal flush is between posts stops it at its next post, its acks held (ported: "poison preempts a normal recovery lease before its stale flush starts", "a flush preempted by a poison repair hands the acks it got to the poison rebase's commit").
8. A rejection landing while `deliverLeased` delivers the lane ahead posts no leased batch (Task 5).

## Replica mode: the writers before and after

**Before.** Every report reaches the session's `reportMode`, which folds it with the socket status of that moment.

| Writer | Reports | When |
|---|---|---|
| session `startup()`, `runtime === null` | `no-replica`, no error | once, the only writer in such a session |
| `replicaSync.noteSuccess` | `ready` | `doStart` (forced); a pull or recovery after a reported failure; `resetLocalData` (forced) |
| `replicaSync.noteNoReplica` (sets `usable = false`) | `no-replica` with error | `doStart`'s init meets a session-fatal error; `noteFailure` sees one from a pull or a start |
| `replicaSync.noteFailure` | `stalled` | the stall threshold of counted failures |
| `replicaSync.runRecovery` | `recovery-failed` | a reporting recovery throws, session-fatal errors included |
| `clientRuntime.continueStartup` via `onReplicaState` | `no-replica`, no error (plus a `replica-unusable` event) | discovery meets the latched failed open; `usable` untouched |

Orders seen: `no-replica` (runtime) then `no-replica` (init, at the next connect's `start()`); `recovery-failed` then `no-replica` in one pass; `stalled` then `no-replica`; `no-replica` then `no-replica` again from an owed pull run or a later `start()`. The queue latches the same death from its own RPCs and tells nobody.

**After.**

| Writer | Reports |
|---|---|
| session `startup()`, `runtime === null` | `no-replica` with `absentReplica()`'s message (Question 2) |
| `replicaSync`'s one internal `setMode` | every other report; drops anything once `no-replica` was reported |
| `replicaSync.noteUnavailable(error)` | the one door to `no-replica`: sets `usable = false`, clears the retry timer, reports once. Called by `doStart`'s init branch, `noteFailure`'s session-fatal branch, `clientRuntime.continueStartup`'s unusable branch and the queue's `onUnavailable` latch |

`runRecovery`'s catch reports nothing for a session-fatal error (it is rethrown to `noteFailure`). `start()` and `pull()` return at once when not `usable`, and `pullRun`'s run checks `usable` at its top beside `stopped`, so an owed pass after the death calls no replica method.

## Leased delivery: `flushBatches` today, step by step

| Step | Today in `flushBatches` | After |
|---|---|---|
| 1 | for each leased batch | stays in `replicaSync` |
| 2 | skip a `poisoned` row | stays |
| 3 | `beforePost()` | stays |
| 4 | `queue.deliverLaneAhead(batch_id)`: posts the lane entries it follows, each acked through `noteCommitted` | moves into `deliverLeased` |
| 5 | `beforePost()` again | moves: `deliverLeased` calls the `beforePost` it is given |
| 6 | builds `{client_id, batch_id, ops, seen_seq?}` and POSTs it through `fetchJson` | moves: the queue's `postOps` (its `post` dep and `clientId`) |
| 7 | `opsAckOfWire` then `readOpsAck` | moves: `noteCommitted` |
| 8 | a skipped op emits `replicaSync`'s `skipped` | moves: `noteCommitted` emits the queue's `onSkipped` |
| 9 | `heldAcks.push({ id, batch_id, seq })` | stays, from the returned reading |

`deliverLeased` posts under the `recovery` claim its caller holds, as `deliverLaneAhead` does now, so it never consults `terminalReason`. It throws once disposed. It settles no ticket and no lane mark: the commit deletes the row, and `finishAllDeliveries` or `settleCommitted` settle as today (Question 6).

## Tasks

Each task is one commit unless it says otherwise, in its own worktree off `refactor/sync-poison-mode`, merged back with `--no-ff`. "Web gates" means the list in Global Constraints.

### Task 1: Rename the legacy outline repair

**Implementer:** sonnet. **First**, before any behavioural task.

**Files:** `git mv web/src/sync/legacyRepair.ts web/src/sync/outlineRepair.ts` and its test; every reference in `web/src` and `web/e2e`; identifier references in `docs/architecture/` and `docs/troubleshooting.md` (identifiers only, no other wording; load the `architecture-docs` skill and run its `check-docs.mjs`). Plans and specs under `docs/superpowers/` are history and stay.

- Renames: `legacyRepair.ts` → `outlineRepair.ts`; `createLegacyRepair`/`LegacyRepair`/`LegacyRepairDeps` → `createOutlineRepair`/`OutlineRepair`/`OutlineRepairDeps`; `legacy-rejected` → `outline-rejected`; `legacy-repair-started|succeeded|failed` → `outline-repair-*`; `legacyBehind` → `outlineBehind`; `retryPolicy`'s `legacy-repair` plan kind → `outline-repair`; `LegacyRejectedMessage`/`LegacyRejectedBanner` → `OutlineRejected*`; the session's `legacyRepair` local; `syncState.ts`'s `LegacyProblem` and `legacy()` helper; the queue suite's `legacyStable`/`legacyFails`/`legacyDone` commands and its labels (`legacy stable: …`, `legacy repair fails`, `lane rejected after a legacy repair's onStable`) with their floor keys in `queue.prop.ts`, values unchanged; test names and comments that name this repair ("the legacy repair" → "the outline repair").
- **Persisted or user-visible names: none.** `SyncProblem` kinds, `SyncEvent` types and `RetryPlan` kinds live in memory (the session's fold and React state). The only `localStorage` key in sync is `pkm.poison-mark-intents.v1`, whose `PoisonEvent`s carry no such name. No replica table, server field, route or socket frame carries one (`git grep` over `server/` finds only unrelated "legacy" prose). The banner copy reads "Server rejected a change…" and no class, test id or e2e selector uses the name; two e2e specs name it in comments. Floor keys are code. So every name renames outright.
- **Done:** web gates green with no test assertion changed beyond the renamed strings; `git grep -n -E "legacy-(rejected|repair)|legacyBehind|legacyRepair|LegacyRepair|LegacyRejected|legacy(Stable|Fails|Done)" -- web docs/architecture docs/troubleshooting.md` finds nothing; the diff is renames only (`git diff --stat -M` shows the file moves as renames).
- [ ] **Orchestrator:** `proptest/check.sh web --file sync`: the baseline. The renamed floors must pass under their new keys; keep both suites' tallies.

Why first: every later commit, and the docs task, then writes the final names once. Done last, the rename would sweep comments and doc sentences Tasks 2 to 7 wrote, and the queue suite's label keys would change after the baseline tallies the later comparisons read.

### Task 2: `OpQueue.holds` and `onRelease`, and the queue model's claim rules

**Implementer:** opus (the model rules and their teeth).

**Files:** `web/src/sync/opQueue.ts`, `opQueue.replica.test.ts`; `web/src/props/sync/queueModel.ts`, `queueHarness.ts`, `queueTeeth.prop.ts`.

- [ ] **Red tests** in `opQueue.replica.test.ts`, `describe("barrier claims")`:
  - `holds reports each owner's claim from its pause until its own resume`
  - `holds("poison") is true from construction while a reload's mark intents are retained`
  - `a durable rejection claims poison before its mark is written` (hold `markPoisoned`; `holds("poison")` is already true)
  - `onRelease fires once when resume releases a held claim, and not for an owner that was not held`
  - `onRelease runs after the release, so holds() is already false inside it`
- [ ] **Run; expect FAIL** (methods missing).
- [ ] **Change:** `holds(owner: BarrierOwner): boolean` reads `qstate.holders`. `onRelease(fn)` is a listener set; `resume(owner)` emits it after `dispatch` when the owner was held. The header's "no method here may emit synchronously" is restated as the rule it protects: no emission may reach a report during render; `resume` is reached only from effects and async paths, and `onRelease`'s listener reports nothing synchronously (Question 1).
- [ ] **Model** (`queueModel.ts`, from `sync-recovery.md` § The recovery barrier; Task 7 adds the sentence it cites). Two rules, added to the header list:
  - `claim`: after every command settles, `queue.holds(o)` is true for every owner the model holds. The queue may hold longer (it releases `poison` only after the repair's delete loop, the model at the delete), so the rule is one-sided.
  - `release`: once quiescent, the queue holds no owner.
  `barrier`, `order` and `delivery` are unchanged, as is the model's state. `queueHarness.ts` checks `claim` after each command's `settle()` and `release` with the quiescence findings (its message names `held by the queue` so the not-quiet finding stays distinct).
- [ ] **Teeth** in `queueTeeth.prop.ts`: `a queue that never reports a claim` (`holds` mocked to false; catches `claim`), and `a poison repair that never releases its claim` (the runtime's success path skips `resume("poison")`; catches `release`).
- **Reach:** no new label. The claim rule is judged whenever the model holds an owner, which the floored labels already show: `durable batch rejected`, `lane batch rejected`, `recoveryStart`, `pauseStartup`.
- **Done:** web gates green; the existing queue property and teeth green.
- [ ] **Orchestrator:** `proptest/check.sh web --file sync`; record the two teeth results.

### Task 3: The poison claim is the barrier's

**Implementer:** opus.

**Files:** `web/src/sync/replicaSync.ts`, `clientRuntime.ts`, `opQueue.ts`, `session.ts`, their tests, `barrier.test.ts`, `session.test.ts`; `web/src/props/sync/queueHarness.ts`, `harnessClient.ts`.

- [ ] **Red tests:**
  - `clientRuntime.test.ts`: `discarding a rejected change while a repair runs keeps the poison claim until the repair ends`. Hold the rebase (`opts.rebase`), `emitPoison`, call `runtime.discardPoisonIntents()`. Until the rebase resolves, the recorded calls after `discardPoisonIntents` are empty: no release of any kind. After it resolves, they end in `resume(poison)`. Red today: `completeAuthoritativeRepair(poison)` is recorded at the discard. Green after, with the fake's `completeAuthoritativeRepair` deleted from `setup` and the assertions untouched.
  - `barrier.test.ts`: `a reset and a pass needing recovery wait for a repair whose change was discarded`. The real queue, the real `replicaSync` and the runtime over `memReplica`, with the poison rebase's `prepareRecovery` held. After the discard, `replicaSync.resetLocalData({ discardPending: true })` rejects with "rejected-batch repair in progress", and a nudge whose window answers needs-bootstrap makes no second `prepareRecovery` until the repair ends. Wire the parts in one local `wire()` helper: between red and green only `wire()` changes.
  - `session.test.ts`: `a connect while a reload's poison mark keeps failing leaves recovery to the poison claim`. A retained intent in the `poisonStore`, `markPoisoned` rejecting with a plain error, a window answering needs-bootstrap. After the first connect, `prepareRecovery` was never called and no `recovery-failed` was reported. If this one is green today, report it: the premise row above is then wrong.
- [ ] **Run; expect FAIL.**
- [ ] **Change:**
  - `replicaSync.ts`: `ReplicaSyncDeps` gains `holdsPoison?: () => boolean` (default `() => false`); its `queue` loses `onPoisonPending`/`onPoisonMarkUnmatched` and gains an optional `onRelease`. `authoritativeRepair`, both listeners and `completeAuthoritativeRepair` go; every read becomes `holdsPoison()`: `assertNormalRecoveryStillOwnsFlush`, `runRecovery`'s `poisonOwnsRecovery`, `rebaseForUnappliableWindow`, `leftToPoison`, both `pullLoop` checks, `resetLocalData`, `payPoisonPull`. `queue.onRelease?.((owner) => { if (owner === "poison") payPoisonPull(); })`. `rebaseAuthoritative`'s doc: the caller holds `poison` before calling; nothing here claims it.
  - `clientRuntime.ts`: both `completeAuthoritativeRepair` calls go; `ClientRuntimeDeps.replicaSync` drops it. A new `queue.onPoisonMarkUnmatched` listener: `if (live() && !discovering && !repairOnce.running()) queue.resume("poison")`. `ClientRuntimeDeps.queue` gains `onPoisonMarkUnmatched`.
  - `opQueue.ts`: `onPoisonPending` and its listener set go; `rejectDurableBatch`'s pause comment says the claim is what a lease reads.
  - `session.ts`: `holdsPoison: () => queue.holds("poison")`.
  - `queueHarness.ts`: the stand-in loses `completeAuthoritativeRepair`. `harnessClient.ts`: `poisonOwns(syncEvents)` becomes `session.queue.holds("poison")`, and `POISON_EVENTS` goes if nothing else reads it.
- [ ] **Port (setup only):** `replicaSync.test.ts` "poison owns recovery when a held feed needs bootstrap through failure and retry", "poison preempts a normal recovery lease before its stale flush starts", "an unmatched poison round releases ownership so a later needs-bootstrap pull can rebootstrap" (its release half becomes a fake barrier whose release fires `onRelease`; the unmatched half moves to `clientRuntime.test.ts`), "resetLocalData rejects immediately when poison …", "resetLocalData releases only its own claim when poison now owns recovery", "a flush preempted by a poison repair hands the acks it got to the poison rebase's commit", "a pull whose recovery meets a dead worker after poison claimed recovery reports no-replica", "a pull that joined one left to a poison repair still runs its own pass", "work left to a poison repair is pulled again once the repair releases recovery". One shared fake in the file: `fakeClaim()` with `holds`, `claim()`, `release()` firing the release listener. `clientRuntime.test.ts`: every recorded call list drops `completeAuthoritativeRepair(poison)` and nothing else. `opQueue.replica.test.ts`'s two `onPoisonPending` tests become `holds("poison")` assertions at the same moments.
- [ ] **New tests** (new owner, so not red): `clientRuntime.test.ts` `an unmatched marking round releases poison when no repair runs`, `an unmatched marking round during a repair keeps the claim`, `an unmatched marking round during discovery leaves the release to continueStartup`.
- **Done:** web gates green; `git grep -n -w -e authoritativeRepair -e onPoisonPending -e completeAuthoritativeRepair web/src` finds nothing.
- [ ] **Orchestrator:** `proptest/check.sh web --file sync`, then the Task 3 mutants (Property gate).

### Task 4: One mode writer

**Implementer:** opus.

**Files:** `web/src/sync/replicaSync.ts`, `clientRuntime.ts`, `opQueue.ts`, `session.ts`, `syncState.ts`, `retryPolicy.ts`, `web/src/replica/errors.ts`, their tests; `web/src/props/sync/queueHarness.ts`, `oracle.ts`, `sync.prop.ts`.

- [ ] **Red tests:**
  - `replicaSync.test.ts`: `a recovery that meets a dead worker reports no-replica and never recovery-failed` (the scratch reproduction: `states` is `ready, no-replica`).
  - `replicaSync.test.ts`: `noteUnavailable reports no-replica once, and nothing is reported or called after it` (a second `noteUnavailable`, an owed pull run, a `start()`: no further report, no replica call, no retry timer).
  - `syncState.test.ts`: `a no-replica report replaces a stalled banner`, and the guard `a no-replica report keeps a delivery problem`.
  - `session.test.ts`: `a queue RPC that meets a dead worker reports no-replica before any pull` (a started session; `enqueue` rejects with `RpcLifecycleError("worker-error")`; mode `no-replica` with the error, `appliedVersion()` null, no changes fetch since).
  - `session.test.ts`: `a replica startup finds unusable answers appliedVersion null and reports its mode once` (`report.replicaState` once, with the error; problem `replica-unusable`).
- [ ] **Run; expect FAIL.**
- [ ] **Change:**
  - `replica/errors.ts`: `export type SessionFatalError = ReplicaUnusableError | RpcLifecycleError`. If `isSessionFatal` becomes a type predicate, note its false branch: a timeout `RpcLifecycleError` is not fatal, so a predicate narrows wrongly on a typed union. Callers pass `unknown`, where it does not; a separate `asSessionFatal(error): SessionFatalError | null` avoids the question.
  - `replicaSync.ts`: `ReplicaState`'s `no-replica` gets `error: string`. One `setMode(next)` wraps `onState` and drops every report once `no-replica` was reported. `noteNoReplica` becomes the public `noteUnavailable(error: SessionFatalError)`. `runRecovery`'s catch reports nothing for a session-fatal error. `start()` and `pull()` return at once when not `usable`; `pullRun`'s run returns at its top when `stopped || !usable`.
  - `opQueue.ts`: `onUnavailable(fn: (error: SessionFatalError) => void)`, emitted once by `noteReplicaFailure` when the latch sets.
  - `clientRuntime.ts`: the unusable branch calls `replicaSync.noteUnavailable(error)` (inside the existing `live()` guard) and stops emitting `replica-unusable`; `ClientRuntimeDeps.onReplicaState` goes, `replicaSync` gains `noteUnavailable`.
  - `session.ts`: `queue.onUnavailable((error) => replicaSync?.noteUnavailable(error))` among the `offs`; the null case reports `{ mode: "no-replica", error: <absentReplica's message> }` (a shared constant in `session.ts`).
  - `syncState.ts`: `bannerForMode`'s `no-replica` always raises `replica-unusable`; `replicaUnusable` replaces `replica-stalled` and still keeps every other kind; the `replica-unusable` `SyncEvent` and its `retryPolicy` case go.
  - `queueHarness.ts`: the stand-in's `onReplicaState` becomes `noteUnavailable: () => undefined`.
  - `oracle.ts` `ModeWatch`: a new check, `afterEdit(c)`: once a client's worker has died and an edit has gone through its queue, the mode is `no-replica` and `appliedVersion()` is null, started or not. `sync.prop.ts` calls it after the `Edit` command settles on a client whose worker died (the path `Edit with a dead worker` counts). The header's ninth check names both moments.
- [ ] **Port:** `clientRuntime.test.ts` "unusable replica at discovery reports no-replica" and its sibling at the second `replica-unusable` assertion record a `noteUnavailable` call instead of a state and an event. `syncState.test.ts` cases that fold `{ type: "replica-unusable" }` fold a `no-replica` report instead, with the expected problem unchanged; the case for `no-replica` without an error goes with the shape. `session.test.ts` "with no replica, startup reports no-replica…" and `SyncProvider.test.tsx` "without a replica the provider reports no-replica mode" expect the error (Question 2).
- **Done:** web gates green; `git grep -n '"replica-unusable"' web/src/sync` finds only the problem kind; `git grep -n onReplicaState web/src` finds nothing.
- [ ] **Orchestrator:** `proptest/check.sh web --file sync`, then the Task 4 mutants.

### Task 5: The queue delivers leased batches

**Implementer:** opus. Two commits: the change, then the `clientId` removal.

**Files:** `web/src/sync/opQueue.ts`, `replicaSync.ts`, `session.ts`, `opQueue.replica.test.ts`, `replicaSync.test.ts`, `session.test.ts`.

- [ ] **Red tests** in `opQueue.replica.test.ts`, `describe("deliverLeased")`:
  - `deliverLeased delivers the lane entries the batch follows, then posts the batch, and returns its reading` (through the `post` dep; body `{client_id, batch_id, ops, seen_seq?}`, `seen_seq` omitted when absent)
  - `deliverLeased checks beforePost after the lane ahead and posts nothing when it throws`
  - `deliverLeased's ack naming a skipped op reaches onSkipped once`
  - `deliverLeased throws once disposed and posts nothing`
  - `deliverLeased leaves the batch's ticket and lane mark to the commit` (its `delivered` stays pending)
  - `settleCommitted with a batch whose stored ack skipped an op emits onSkipped once`
  - `session.test.ts`: `a recovery flush whose ack skips an op bumps resync once` (guard: one `ops-skipped` fold, not two)
- [ ] **Run; expect FAIL.**
- [ ] **Change:** `deliverLeased(batch: PendingBatch, beforePost: () => void): Promise<OpsAckReading>` per the step table. `deliverLaneAhead` leaves the interface and stays an internal function. `settleCommitted(batches: readonly { batch_id: BatchId; skipped: readonly SkippedOp[] }[])` emits `onSkipped` once if any skipped. `flushBatches` keeps steps 1 to 3 and 9 and calls `deliverLeased(b, beforePost)`; `settleApplied` passes the batches to `settleCommitted`. `replicaSync`'s `skipped` set, `onSkipped` and its interface entry go; its `queue` dep swaps `deliverLaneAhead` for `deliverLeased`. `session.ts` drops the second `onSkipped` subscription and its comment.
- [ ] **Port:** the `replicaSync.test.ts` flush tests that read `/api/ops` POSTs from `fetchJson` read them from a recording `post` on a real `createOpQueue` passed as the `queue`; what was posted is asserted unchanged. "the recovery flush delivers each batch's lane-ahead entries before posting it" and the two "a recovery flush whose ack names … onSkipped" tests move to `opQueue.replica.test.ts` as `deliverLeased` tests. The `settleApplied` tests ("the pull hands the rows the replica dropped to the queue", "a dropped batch whose ack skipped an op bumps resync once, as the ack would", "a bootstrap names the pending batches init read…") assert `settleCommitted`'s argument and the queue's `onSkipped`. The six `deliverLaneAhead` tests port to `deliverLeased`: lane assertions unchanged, the leased POST appended.
- [ ] **Second commit (mechanical):** `ReplicaSyncDeps.clientId` goes, with every `clientId:` line in `createReplicaSync` calls (tests, `session.ts`). Nothing else.
- **Done:** web gates green; `git grep -n -e deliverLaneAhead -e '"/api/ops"' web/src/sync/replicaSync.ts` finds nothing.
- [ ] **Orchestrator:** `proptest/check.sh web --file sync`, then the Task 5 mutants.

### Task 6a: Replica-side small changes

**Implementer:** sonnet. **Parallel lane:** touches only `web/src/replica/`, which no other task edits; merge any time before Task 7.

**Files:** `web/src/replica/queue.ts`, `workerHandlers.ts`, `carryStore.ts`, `client.ts`, `queue.test.ts`.

- [ ] **Red test** in `queue.test.ts`: `a poisoned row whose error is not the stored JSON reads as a generic rejection` (an `error` of `"request failed: 409 conflict"` reads `{ status: 400, message: "rejected batch from a previous session" }`; today 409 and the string).
- [ ] **Run; expect FAIL.**
- [ ] **Change:** `poisonDetails` keeps the JSON parse; anything else, `null` included, reads as the generic rejection. `readPendingRows(db, after?: PendingRowId): DurablePendingRow[]` in `queue.ts` beside `DurablePendingRow`; `readDurablePendingRows`, `salvagePendingRows`' step and `carryStore.read` call it, each keeping its own table check. Delete `su05` from `client.ts`'s `enqueue` doc, keeping the sentence it starts.
- **Done:** web gates green; `git grep -n "error AS pending_error FROM pending_ops" web/src/replica` finds one line.

### Task 6b: Sync-side small deletions

**Implementer:** sonnet. After Task 5 (shares `opQueue.ts`, `clientRuntime.ts`, `syncState.ts`, `errors.ts`).

**Files:** `web/src/sync/poisonIntents.ts`, `clientRuntime.ts`, `opQueue.ts`, `syncState.ts`, `web/src/replica/errors.ts`.

- No red test: nothing changes for a caller.
- [ ] **Change:** export `orderedPoisonEvents(...groups)` from `poisonIntents.ts` (today's `ordered`, taking groups); `parseStoredIntents` and `withIntent` use it; `clientRuntime.ts`'s four `mergePoisonEvents` uses switch and the function goes. Delete the three quota tombstone comments.
- **Done:** web gates green; `git grep -n mergePoisonEvents web/src` and `git grep -n -i quota -- web/src ':!*.test.*'` find nothing.

### Task 7: Docs say what W10 made true

**Implementer:** sonnet (`architecture-docs` skill). Last.

**Files:** `docs/architecture/sync-recovery.md`, `sync-and-offline.md`, `docs/troubleshooting.md`, the epic plan's W19 table.

- `sync-recovery.md` § The recovery barrier: the `poison` row's Released column gains "when no repair runs" on the unmatched and discarded cases, and one sentence: `OpQueue.holds(owner)` reports a claim, `replicaSync` reads `holds("poison")` as the poison repair's claim on recovery, and a release of `poison` pays the pull a repair left owed. `queueModel.ts`'s `claim` rule cites this sentence.
- § A batch the server rejects: the `authoritativeRepair` paragraph and its ownership table go, replaced by the claim being the barrier's. The guard table's first row becomes: `rejectDurableBatch` pauses `poison` before the durable mark, and the flush's `beforePost` reads `holdsPoison()` before every leased batch and again inside `deliverLeased` after the lane ahead. The owed-pull sentence says it is paid when the queue releases `poison`.
- § Replica mode: the `no-replica` row's Entered column names `noteUnavailable` and its callers, the queue's latch among them; the `recovery-failed` row says a session-fatal error is not one; a sentence that no mode is reported after `no-replica`. "Nothing reports the death…" becomes: the death is reported at the next replica call, the queue's or `replicaSync`'s, whichever comes first.
- § What the UI shows: `replica-unusable` is raised by every `no-replica` report and replaces a stalled banner, never a delivery problem; the no-replica-environment case per Question 2.
- `sync-and-offline.md` § When views refetch: the skipped-ops row's Where is `opQueue.ts` alone (the drain, the lane, `deliverLeased`, `settleCommitted`); the paragraph under it says every POST site is the queue's. § A payload that already holds a pending batch, Settle row: `settleCommitted` takes each batch's `skipped`. § Key pieces only if a row names `replicaSync` as a POST site.
- `troubleshooting.md`, bean `pkm-onr2`: one row for the banner. Symptom: after the replica worker dies during a recovery, or after a stall, the banner says "Local sync is stuck" and offers Reset, which fails, instead of "Working online only" with Reload. Cause: `runRecovery` reported `recovery-failed` before `no-replica`, and `replica-unusable` never replaced `replica-stalled`. Owner: § Replica mode. One row for interleaving 3 only if its red test failed. Owner: § A batch the server rejects. The discard-during-repair case is unreachable from the UI (a running repair moves the problem off `mark-failed`, which `discardProblem` requires), so it gets no row; the commit says so.
- Epic plan, W19 table: the rows in "W19 additions" below.
- **Done:** `node .claude/skills/architecture-docs/check-docs.mjs` passes; `lint:comments` green.

## Order and parallel lanes

```
T1 -> T2 -> T3 -> T4 -> T5 -> T6b -> T7
T6a (any time after T1; merge before T7)
```

| File | Tasks | Rule |
|---|---|---|
| `sync/outlineRepair.ts`, `syncState.ts`, `retryPolicy.ts`, `OfflineIndicator.tsx`, props labels | T1, then T4 (`syncState.ts`, `retryPolicy.ts`) | serial |
| `sync/opQueue.ts` | T2, T3, T4, T5, T6b | serial |
| `sync/replicaSync.ts`, `session.ts`, `clientRuntime.ts` | T3, T4, T5, T6b | serial |
| `props/sync/queueModel.ts`, `queueHarness.ts`, `queueTeeth.prop.ts` | T2, T3, T4 | serial |
| `props/sync/oracle.ts`, `harnessClient.ts`, `sync.prop.ts` | T3, T4 | serial |
| `replica/queue.ts`, `workerHandlers.ts`, `carryStore.ts`, `client.ts` | T6a | parallel lane |
| `replica/errors.ts` | T4, T6b | serial |
| docs | T1 (identifiers), T7 | implementers leave prose to T7 and say in their commit what became true |

Tasks 2 to 5 also run serially because each one's property run must measure that task alone, and the gate is a machine-wide serial resource (port 8978).

## Property gate

The sync suites depend on timing, so a seed does not replay the same example before and after a change. The evidence is the floors, the unfloored tallies, the committed teeth, and one or two uncommitted mutants per behavioural task.

1. **Baseline** after Task 1: `proptest/check.sh web --file sync`; keep the tallies both suites print. The queue suite's renamed floors must pass under their new keys.
2. **After each of Tasks 2 to 5**, `proptest/check.sh web --file sync`. The gate judges every floor. Compare the unfloored labels with the baseline and report differences as facts.
3. **Models.**
   - `queueModel.ts`: two new rules, `claim` and `release` (Task 2). `barrier`, `order`, `delivery` and the model's state do not change. The harness's stand-in `replicaSync` changes shape in Tasks 3 and 4 (no `completeAuthoritativeRepair`; `noteUnavailable` for `onReplicaState`) and does nothing new.
   - `oracle.ts` `ModeWatch`: one new check, `afterEdit` (Task 4). `observe` and `afterPull` do not change.
   - `model.ts` and the rest of the oracle model server and replica data, which W10 does not change.
   - A suite that fails is judged against the docs first. A model is edited only where the docs say it is wrong, never to match new code.
4. **Mutants.** Uncommitted, applied to the task's code only, two seeds each with `proptest/check.sh web --file sync --seed <n>`, then reverted. Record which invariant fired, or that none did:

   | Task | Mutant | Expected |
   |---|---|---|
   | 2 | committed in `queueTeeth.prop.ts`: `holds` always false; the repair's success skipping `resume("poison")` | `claim`; `release` |
   | 3 | `session.ts` passes `holdsPoison: () => false` | uncertain. The fixed scenario "a nudge joined to a pull left to a poison repair gets its own pass" leaves its needs-bootstrap to the repair only through the claim, but its armed death ends the replica on either path, so `ReleasePulls`' mode check may pass. Random examples could fail `accounting` or `convergence` if a normal rebase flushes past a poisoned row. A survival goes to the W19 claim row |
   | 3 | `clientRuntime`'s discard and unmatched releases ignore `repairOnce.running()` | likely survives: neither suite draws a discard or an unmatched marking round. The unit tests are the guard |
   | 4 | `session.ts` drops the `queue.onUnavailable` wiring | `ModeWatch.afterEdit`, reached through `Edit with a dead worker` |
   | 4 | `noteUnavailable` leaves `usable` true | `ModeWatch.afterPull`'s `appliedVersion` check |
   | 5 | `deliverLeased` skips the lane ahead | per-client order, if a `RotateGeneration` rebase meets a lane entry ahead of a leased row; likely survives, since nothing labels that path |
   | 5 | `deliverLeased` does not call `beforePost` | survives: no suite draws a rejection during a leased flush. The unit test is the guard |

   A surviving mutant is a fact about reach, reported with the table and carried to W19 below. It is not a new rule here.
5. **Labels whose reach could move.** Queue suite: none beyond the renamed keys; Task 2 adds rules, not draws. Sync suite: `Pull joined` and `Pull joined under poison` (Task 3 reads the claim from `holds` instead of events; the two agree except for a reload's retained intents before discovery, when no pull is in flight); `Edit refused: read-only, mode no-replica` (Task 4 reports the death at the queue's first failed RPC, so likely more); `Edit refused: read-only, mode stalled` and `… recovery-failed` (unfloored, likely fewer); `Problem at settle: replica-stalled` and `… replica-unusable` (unfloored; Task 4 moves counts from the first to the second).
6. **Floors.** None changes in W10 without re-measurement by `reach.ts`'s recipe (`PROPTEST_REACH_LOG`, unseeded runs on a quiet machine, the orchestrator's call), and none is lowered to pass. A floor that fails after a task is first a question: does the label's path depend on that task? If it does, re-measure and commit the new floor saying why. If it does not, it is a finding: investigate before anything else. No budget and no example count changes.
7. **Fault warnings:** an `UNEXPECTED` entry in a suite's `fault warnings` line is a finding, never an `EXPECTED_KINDS` addition without that reasoning.
8. **Final:** `proptest/check.sh web` (the whole side) on the final branch.

## Findings

**A. The dead-worker banner.** Reproduced above; fixed in Task 4 because the one-writer rule removes its cause. Without the fix, a session whose worker dies during a feed rebase shows "Local sync is stuck" with a Reset that cannot succeed.

**B. A repair that succeeds while not live leaves `poison` held.** `runRepair` resumes `poison` only when `live()`. Between a StrictMode cleanup and the replay that keeps the session (development only; a real unmount disposes the session), a repair finishing leaves the claim held and, after W10, its owed pull unpaid; today the flag clears and the pull runs while delivery stays blocked. Either way edits wait until a reload. Not fixed here (Question 7).

**C. `pkm-jowv` stays its own bean.** A reconnect's pull owed behind a failing pass is rejected with that pass (`coalesce`'s rule), `pull()` swallows it, and the completion sees no movement. The fix changes what `pull()` and `start()` tell the reconnect completion, and the completion's "moved" rule. W10 changes neither: its `pull()` edit is the `usable` guard, and `payPoisonPull` owes a pull for a pass that ended without failing. Run it after W10 merges; it shares `replicaSync.ts` and is independent of W11's `runRecovery` work.

## Traps

- **Excess-property errors on fakes.** Typed fakes (`ClientRuntimeDeps["replicaSync"]`, the queue stub objects) fail to compile once a member goes. That is the port, and only the setup changes.
- **Reading the claim one step late.** `rejectDurableBatch` pauses before any await, so `holds("poison")` is true where `onPoisonPending` fired. Keep it first.
- **The pull now starts after the drain's kick.** `resume("poison")` kicks the drain inside `dispatch`, then `onRelease` starts the owed pull. Both begin with an await; a test that counted on the pull starting first is reported, not padded.
- **`noteUnavailable` on a stopped instance.** The latch can fire during teardown. `reportMode` already drops it (`live()`); `noteUnavailable` must arm nothing.
- **Microtask counts.** Ported tests that `await flush()` a fixed number of times may need none changed; one that fails on timing is reported.
- **Brand rules, FCIS, comment lint.** `PendingRowId` in `readPendingRows`; `BatchId` in `settleCommitted`'s shape. Detect: `pnpm lint`, `pnpm check:fcis`, `pnpm lint:comments`.
- **Coverage.** Deleted branches leave their tests; ported tests must still cover `deliverLeased` and `noteUnavailable` fully. Detect: `pnpm test:coverage`.

## Final gates

| Gate | Who |
|---|---|
| Web gates without Playwright | each implementer, per task |
| `proptest/check.sh web --file sync`, steps 1, 2 and 4 above | orchestrator, serially, after Task 1 and after each of Tasks 2 to 5 |
| `pnpm verify` including the full Playwright suite | orchestrator, on the final branch |
| `proptest/check.sh web` (whole side) | orchestrator, serially, on the final branch |
| `perf/check.sh frontend` | orchestrator, serially, on a quiet machine, on the final branch before merge. Fewer duplicate `no-replica` reports can lower render counts; an improvement is committed with the branch, a regression is read against this plan's behaviour changes first |

## W19 additions

| Machine | Converted in | Suite |
|---|---|---|
| The poison claim as `replicaSync` reads it (`holdsPoison`) and its releases | W10 | extend `props/sync/`: the queue suite's `replicaSync` is a stand-in, and neither suite draws a discard or an unmatched marking round during a repair. Guarded by `clientRuntime.test.ts` (`discarding a rejected change while a repair runs keeps the poison claim until the repair ends`, the unmatched-round tests), `barrier.test.ts` and `session.test.ts` (`a connect while a reload's poison mark keeps failing leaves recovery to the poison claim`) |
| Leased delivery in the queue suite | W10 | the recovery stand-in flushes its lease through `deliverLeased`; the model then needs a rule that a recovery's own leased POSTs pass its own claim, a change to `barrier`. Listed only if Task 5's lane-ahead mutant survives |
| Banner under `replica-state` events (W8's row) | W8, W10 | add: a `no-replica` report replaces a stalled banner and never a delivery problem |

## Questions for Arthur

1. **`onRelease` emits synchronously inside `resume`.** `opQueue.ts`'s header forbids synchronous emission; its reason is that no report may run during render, and `resume` is reached only from effects and async paths. Recommendation and default: emit synchronously and restate the header rule as that reason. The alternative, a microtask hop, adds a gap in which a re-claim and the pull race.
2. **The no-replica environment gets the online-only banner.** With `error` required, the session's `runtime === null` report carries `absentReplica()`'s message and raises the banner, which only jsdom and `replica={null}` tests reach; tests asserting its absence there are updated. The alternative keeps an optional error for that one case, and with it the second path to the banner. Recommendation and default: required everywhere, banner shows.
3. **The offline gateway keeps its render-lagged `modeRef`.** With one writer, `session.replicaState()` is current synchronously and the gateway could read it. W8 kept the ref deliberately and no failure is known. Recommendation and default: leave it.
4. **The claim covers a reload's retained intents before their repair.** A connect during a failing startup mark then leaves a needed recovery to the claim instead of flushing past the unmarked rejected row. Recommendation and default: accept, pinned by Task 3's session test.
5. **The dead-worker banner fix rides in Task 4.** It is a bug fix with a troubleshooting row, and the one-writer rule is its fix. Recommendation and default: in W10.
6. **`deliverLeased` settles no ticket.** It could resolve the batch's `delivered` and drop its lane mark at the ack, as `settleCommitted` does, but the outline session's replay reads `delivered`, and settling earlier than today changes when tracked writes resolve. Recommendation and default: settle nothing, as today, pinned by Task 5's guard.
7. **Finding B.** A dev-only window, present before W10 in a different form. Recommendation and default: file a bean; no change here.
