# W9 Sync Coalesce: Task-Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Implementers work under the epic's implementer brief; this plan does not restate it.

**Goal:** One helper, `sync/coalesce.ts`, owns the rule "a call that arrives during a run settles only after a run that could have served it". Five of the six hand-written copies the epic names move onto it, one commit each; the sixth (`opQueue.drain`) keeps its own code, for the reason recorded below. Three of the five copies lose a late caller today in the gap between their last check and the line that clears their in-flight promise; the conversion closes that gap, with a red test per site.

**Architecture:** `coalesce(run, { merge, joinable })` returns a callable that also carries two reads, `idle()` and `running()`. A call while quiet starts a run. A call during a run joins it while `joinable()` holds, and is otherwise owed one run after it, its arguments merged with any other owed call's. A rejecting run rejects its joiners and its owed callers. Each site keeps its own state for what a joiner hands to a running run (a target list, an error, a loop flag); the helper owns when a call joins, when it is owed, and the gap after a run's last step.

**Tech stack:** TypeScript, vitest + jsdom, fast-check (`web/src/props/gate.ts`), the queue and sync property suites against a server (`proptest/check.sh web --file sync`).

**Source:** `docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md` § W9, with its Global Constraints and Review Focus item 2. Branch `refactor/sync-coalesce`, read at `6e6e5a44` (W8 merged). W10 and W11 follow on the same files, serially.

## Global Constraints

The epic's Global Constraints apply unchanged. The ones that bite here:

- Web verification for implementers is the web gates without Playwright: `cd web && pnpm typecheck && pnpm lint && pnpm lint:comments && pnpm check:fcis && pnpm test:coverage && pnpm build` (all with `--config.verify-deps-before-run=false`; never `pnpm add/install/update`, `node_modules` is a symlink).
- `pnpm verify`, `perf/check.sh frontend` and `proptest/check.sh web` are the orchestrator's, run serially. The sync suites need the server `proptest/check.sh` starts on port 8978, so no implementer runs them.
- Every pinning test named in the fit table stays green **unmodified**. An implementer who finds one failing reports it with the failure; editing it is a review failure.
- Do not re-propose: folding `usable` into `ReplicaState`, a `socket.ts` phase union, changing `OpsAck.applied`, removing the replay budget.
- Converted machines: none. `coalesce` is a helper, not a machine made explicit, so W9 adds no W19 row of its own (see Question 7 for mutant survivors).
- Comments: no bean ids, line numbers or plan pointers; 80 columns in comments; AGENTS.md's banned word stays out. Docs under `docs/architecture/` go through the `architecture-docs` skill.

## Review Focus

Failure modes no single task's tests are certain to exercise, most likely first.

1. **A lost late caller** (the epic's Review Focus 2). A call landing after a run's last check but before it settles must get a run. Pinned once in the helper (Task 1 `a call landing after the run's last step but before the helper sees it settle gets a run`) and per site by each task's red test.
2. **A joinable flag that flips one step late.** Where a site's run serves joiners by reading state (the target list, the `trailing` flag), `joinable()` must turn false in the same synchronous step as that read. One `await` between them reopens the gap. Pinned by Task 4's and Task 5's red tests.
3. **State read after an owed run has started.** The helper starts an owed run before the finished run's callers resume, so a caller that reads a shared flag (`repairSucceeded`) reads the next run's. Task 5 `continueStartup starts the replica when its own repair succeeded, though another is owed`.
4. **`idle()` identity.** `props/sync/harnessClient.ts` tells a joined pull from a lone one by `idle() === idle()`. Pinned by Task 1's identity test and the sync suite's `Pull joined` floor.
5. **Unhandled rejections.** A site that drops a coalesced promise must catch it, as today. Detect: vitest's unhandled-rejection failure.

---

## Where the code disagrees with W9

The code wins in each case; the tasks below are written to the code.

| W9 says | The code says | What the plan does |
|---|---|---|
| `coalesce` returns `(args: A) => Promise<R>` | Every site reads its in-flight state somewhere besides the call: `runRecovery` awaits `starting` and `pulling`; `replicaSync.idle()` returns `pulling`; `onSeq` branches on `pulling`; `reconnectFlow.finish` without intent returns `finishRun`; `clientRuntime.retryFailedRepair`, `runRetry` and `discardPoisonIntents` read `repairRun`; `legacyRepair.retryFailed` reads `repairRun.done` | The returned callable carries `idle()` and `running()`. They read state and change no call's outcome, so they are not the new option the stop rule guards against. Without them no site converts. See Question 1 |
| Convert `opQueue.drain`, handing only the missed-kick half to the helper | A kick after the run's last check reruns only if the outcome was `drained`, or the block has lifted and no retry is armed; a `drain()` caller in that gap keeps the settled outcome, not the rerun's. The helper's owed call always runs and resolves with the rerun. Expressing the condition needs a "rerun only if" option | Left alone (see the fit table). Its gap was closed by hand and is pinned by the `in-flight kicks` describe. See Question 3 |
| `clientRuntime.repair`: `merge` unions targets | A call during a run merges into the target list the run reads at its delete loop, so a joiner is served without a second rebase; `concurrent poison events coalesce into one repair` pins one rebase for two synchronous events. A never-joinable conversion would rebase twice | `joinable: () => !deleting`, `merge: mergePoisonEvents`; the site merges every call's events into the live list before calling, and the run resets the list from its own arguments at its start |
| `legacyRepair.run`: `joinable = () => !stable` | Matches. The post-stable path chains `repairRun.done.then(() => run(rejectedError))`, which is an owed run with "latest error wins" | `merge: (_, next) => next` |
| `reconnectFlow.finish` | A joined connect extends the running completion: one more `start()` + `idle()` inside the same run, then one resync decision for both gaps. A never-joinable conversion resyncs after the first run's pull and again after the second; `a reconnect that joins a running completion gets a trailing pull` asserts one `resync` at the end and would fail | `joinable: () => !deciding`; the run keeps its `trailing` loop, which is how a joined call is served |
| Red tests per site: "the existing regression test for its historical fix" | `a855c43e` and `62ef7a41` added no test in their commits; the tests that pin them came later. `ac7259ea`'s test pins `applySync`, not the missed kick | The fit table names the test that pins each rule today |
| `proptest/check.sh --file sync` | `--file` is web only, and `sync` is the directory, so it runs `queue.prop.ts`, `sync.prop.ts`, `harness.prop.ts` and `teeth.prop.ts` | Written as `proptest/check.sh web --file sync` |

## How each site handles a late caller today

| Site | A call during a run gets | Joinable decided by | Arguments | A run that throws | Pinned by (stays green unmodified) | Expressed by `coalesce`? |
|---|---|---|---|---|---|---|
| `replicaSync.start` (`starting ??=`) | the start in flight; once `started` is set, `start()` goes to `pull()` instead | always joinable: a call before `started` is set is served by the run's final `await pull()` | none | rejects its joiners; `starting` clears and the next call starts afresh | `replicaSync.test.ts` "concurrent start calls share one initialization", "a failed empty-replica bootstrap (offline first visit) retries on next start" | **Exactly**: `joinable: () => true`. No gap today |
| `replicaSync.pull` (`again`) | the loop's promise; the loop runs one more pass for any number of calls. `onSeq` while pulling sets `again` without its seq check | never joinable: a pass in flight may be past its fetch | none | the loop ends; calls that set `again` are dropped, left to `noteFailure`'s backoff retry or the next reconnect | "overlapping nudges coalesce into a trailing pull"; "a pull that joined one left to a poison repair still runs its own pass" and "work left to a poison repair is pulled again once the repair releases recovery" (`62ef7a41`); `sync.prop.ts` "a nudge joined to a pull left to a poison repair gets its own pass" | **The late-caller rule exactly**: `joinable` omitted; the rejection rule drops owed calls as the loop drops `again`. Gap today: a call after the `while (again)` check, before `pulling = null`, is lost. Incidental differences: success and failure are noted per run, not per loop; `pendingChangedRetries` counts per run; a nudge during a pull whose replica turned unusable no longer buys a pass. See Question 2 |
| `reconnectFlow.finish` (`trailing`) | with intent: the running completion, which then loops once more over `start()` + `idle()`; without intent: the run in flight, or nothing | joinable until the `do … while (trailing && isMounted())` check exits | none; `staleViews` is state, read at the decision | `start()`'s rejection rejects the run and every joiner; nothing owed | `reconnectFlow.test.ts` "a reconnect that joins a running completion gets a trailing pull", "a trailing pull that moves data resyncs a run that found nothing"; `SyncProvider.test.tsx` "a reconnect joining a running completion gets one trailing pull and no stale intent" (`a855c43e`) | **Exactly, with `joinable`**: `joinable: () => !deciding`, the run keeps `trailing`. Gap today: a finish with intent after the loop exits, before `finishRun = null`, sets `trailing` on a run that has decided |
| `clientRuntime.repair` (`repairTargets`) | the run; its events are merged into the live target list. An empty list resolves at once | today always joins, but only a join before the delete loop reads the list is served | union, row order (`mergePoisonEvents`) | never rejects: failure sets `repairFailed` and emits `repair-failed` | `clientRuntime.test.ts` "concurrent poison events coalesce into one repair", "a reconnect during a repair that then fails retries it once", "two connects during a repair that then fails retry it once", "a reconnect during a repair that then succeeds retries nothing" | **Exactly, with `joinable`**: `joinable: () => !deleting`. Gap today: a call after the delete loop starts is merged but never deleted; its row stays poisoned until the next startup discovery |
| `legacyRepair.run` (`stable`, `laneOwed`) | before `onStable`: the run, recording the newer error and owing a `lane` resume; after: a fresh run once this one ends, with the latest error | joinable until the run's `onStable` | latest error wins | never rejects | `legacyRepair.test.ts` "a run while one is in flight joins it and records the newer error" (asserts the same promise object), "a lane rejection joining a local refusal's run is resumed by it", "a rejection arriving after a run's onStable gets a run of its own" (`08a534f7`) | **Exactly**: `joinable: () => !stable`, `merge: (_, next) => next`. No gap today |
| `opQueue.drain` / `kick` (`drainAgain`, `missedKick`) | the run's outcome; `drainAgain` makes the run loop at its drained exits. A kick after the last check reruns (fire and forget) only if the outcome was drained, or the block lifted with no retry armed | until the run returns | none | never rejects (`.catch(failed)`) | `opQueue.replica.test.ts` `in-flight kicks` describe ("a missed in-flight kick does not bypass the scheduled 5xx backoff", "… remains barred by recovery until explicit resume", "dispose drops a missed in-flight kick without another POST"), "a reconnect landing on a blocked drain redrains without a further kick", "an async recovery resume hands a missed kick to the next drain owner" (`ac7259ea`) | **No.** The owed run is conditional on the outcome and on the armed retry, and late callers keep the old outcome. Left alone |

## `coalesce`'s contract

```ts
// web/src/sync/coalesce.ts
// pattern: Imperative Shell

export interface Coalesced<A, R> {
  (args: A): Promise<R>;
  /** Settles once no run is in flight and none is owed; never rejects.
   * Every call within one busy period returns the same promise; a call
   * while quiet returns a new, already resolved one. */
  idle(): Promise<void>;
  /** From a run's start until its busy period ends. */
  running(): boolean;
}

/** Every call settles only after a run that could have served it: one that
 * started after the call, or one that had not yet passed `joinable()` when
 * the call arrived. A run that rejects rejects every call waiting on it or
 * owed behind it. */
export function coalesce<A, R>(
  run: (args: A) => Promise<R>,
  opts: { merge: (pending: A, next: A) => A; joinable?: () => boolean },
): Coalesced<A, R>;
```

Semantics, in the order the implementation must honour them:

- **State.** `current`: the run in flight, holding the one promise every caller it serves receives. `owed`: the merged arguments and the one promise every owed caller receives. `busy`: the `idle()` promise, made on the first `idle()` call of a busy period. A busy period runs from a run's start until no run is in flight and none is owed.
- **A call while quiet** starts a run with its arguments and returns that run's promise.
- **A call during a run, nothing owed:** if `joinable?.()` is true it returns the current run's promise (the same object the starter got). Otherwise it becomes owed with its arguments. Omitted `joinable` means never.
- **A call during a run, a call already owed:** its arguments are merged, `owed.args = merge(owed.args, args)`, and it returns the owed promise. `joinable()` is not asked again in that run: once a call was too late, every later one is too.
- **Starting a run:** `current` is set before `run(args)` is invoked, so a call made from inside `run`'s synchronous part joins or is owed like any call during the run. A synchronous throw from `run` is a rejection of that run.
- **A run that fulfils:** in one reaction to its promise, (1) `current` is cleared, (2) if a call is owed, the owed run starts with the merged arguments, `current` becoming the owed promise, (3) the finished run's promise resolves with its value, (4) if nothing is now in flight, the busy promise resolves and clears. So a caller's continuation always finds the next run already in flight: `running()` is true and a call it makes joins or is owed against that run.
- **A run that rejects:** in one reaction, `current` is cleared, the finished run's promise and the owed promise (if any) both reject with the run's reason, nothing stays owed, and the busy promise resolves. The next call starts afresh.
- **No extra hop:** callers settle in the same reaction that observes the run, so a caller resumes no later than today's `.finally(() => { x = null; })` let it.
- **Unhandled rejections:** the helper adds no handler to the promises it returns. A site that drops one catches it, as every site does now.

## Tasks

Each task is one commit (Task 1 and Task 7 may be two) in its own worktree off `refactor/sync-coalesce`, merged back with `--no-ff`. "Web gates" means the list in Global Constraints. Tasks 2 to 6 are serial: they share `replicaSync.ts` or the property gate between them, and each site's property run must measure that site alone.

### Task 1: `coalesce` and its tests

**Implementer:** opus (the ordering of clear, start-owed and settle; re-entrancy; the identity of `idle()`).

**Files:** `web/src/sync/coalesce.ts` (new), `web/src/sync/coalesce.test.ts` (new).

- [ ] **Red tests** in `coalesce.test.ts`, each against a `run` built from deferreds that records its arguments:
  - `a call while quiet starts a run with its args`
  - `a call during a run gets a second run` (no `joinable`)
  - `calls during one run share one owed run with merged args` (merge sees `(pending, next)` in call order; both callers get the same promise)
  - `a call before joinable() turns false joins the run` (same promise object as the starter's)
  - `a call after joinable() turns false gets its own run`
  - `once a call is owed, joinable() is not asked again in that run`
  - `a throwing run rejects its joiners and the next call runs afresh` (also: its owed callers reject with the same reason and no owed run starts)
  - `a run that throws synchronously rejects like a rejected run`
  - `a call from inside run's synchronous part joins or is owed`
  - `a caller's continuation finds the owed run already in flight` (`running()` true; a call there is owed against the second run, not a third run started beside it)
  - `a call landing after the run's last step but before the helper sees it settle gets a run` (the test's own reaction on the run's promise, registered inside `run` before the helper's, makes the call)
  - `idle() settles after owed runs and never rejects` (including after a rejecting run)
  - `idle() returns one promise per busy period and a new resolved one while quiet`
  - `running() is true from a run's start until nothing is owed`
- [ ] **Run; expect FAIL** (module missing).
- [ ] **Implement** to the contract above. No site uses it yet.
- **Done:** web gates green; `coalesce.ts` fully covered by `coalesce.test.ts`.

### Task 2: `replicaSync.start`

**Implementer:** sonnet.

**Files:** `web/src/sync/replicaSync.ts`.

- No red test: nothing changes for a caller. `start` already joins whatever is in flight and has no gap. The guards are the two pinning tests and the rest of `replicaSync.test.ts`, unmodified.
- [ ] **Change:** `starting` goes. `startOnce = coalesce(async () => { try { await doStart(); } catch (error) { noteFailure(error); throw error; } }, { merge: () => undefined, joinable: () => true })`. `start()` keeps its `started` branch (`await pull()`), else `await startOnce(undefined)`. `runRecovery`'s `await starting?.catch(() => undefined)` becomes `await startOnce.idle()`. The single-flight comment on `start` stays with the code it explains.
- **Done:** web gates green; `git grep -n "starting ??=" web/src` finds nothing; the pinning tests green unmodified.
- [ ] **Orchestrator:** `proptest/check.sh web --file sync` (see Property gate).

### Task 3: `replicaSync.pull`

**Implementer:** opus (failure drops owed calls; `idle()` identity for the harness; `onSeq`'s branch; the poison-break passes).

**Files:** `web/src/sync/replicaSync.ts`, `replicaSync.test.ts`.

- [ ] **Red test** in `replicaSync.test.ts`, `describe("pull retries and the stall report")`: `a nudge from the ready report that ends a stall gets a pull of its own`. Set up as "a successful pull clears the stall and resets the backoff" does (fake timers, `STALL_AFTER_FAILURES` stall-shaped failures, then success). The `onState` listener calls `sync.onSeq(seqOf(9999))` the first time it sees `ready` after `stalled`. That report runs inside `noteSuccess`, after the loop's last `again` check and before `pulling` clears. Expect one more changes fetch after `await sync.idle()` than the retry's own. Today the nudge only sets `again` and is lost.
- [ ] **Run; expect FAIL.**
- [ ] **Change:** `pulling` and `again` go. `pullRun = coalesce(async () => { try { await pullLoop(); } catch (error) { noteFailure(error); throw error; } noteSuccess(); }, { merge: () => undefined })` with `joinable` omitted. `pullLoop` loses its outer `do … while (again)`; `pendingChangedRetries` stays a local of one run; its comment drops "including across an `again`-triggered restart". `pull()`: unchanged guard (`!started || !usable` resolves), else `return pullRun(undefined).catch(() => undefined)`. `onSeq`: `if (pullRun.running()) { void pull(); return; }` before the seq check, with the existing comment. `idle()`: `return pullRun.idle()`. `runRecovery`'s `await (pulling ?? Promise.resolve())` becomes `await pullRun.idle()`. `owePoisonPull`/`payPoisonPull` stay (W10); `owePoisonPull`'s doc loses "a joiner's `again` still gets its own pass", since an owed call now always gets its run.
- **Done:** web gates green; `git grep -n -w -e again -e pulling web/src/sync/replicaSync.ts` finds only prose that is still true; every pull test in `replicaSync.test.ts`, `replicaSync.bootstrapAck.test.ts` and `reconnectFlow.test.ts` green unmodified. The commit message lists the three incidental differences from the fit table.
- [ ] **Orchestrator:** `proptest/check.sh web --file sync`. `Pull joined` must keep its floor: it reads in-flight state through `idle()` identity.

### Task 4: `reconnectFlow.finish`

**Implementer:** opus (`deciding` must flip in the step the loop exits; the intent-less path).

**Files:** `web/src/sync/reconnectFlow.ts`, `reconnectFlow.test.ts`.

- [ ] **Red tests** in `reconnectFlow.test.ts` (the harness gains an `onResync` option):
  - `a connect finished while the completion decides gets its own pull`: `onResync`, the first time, calls `void flow.begin()` and then `flow.observeDrain({ status: "drained" })`. Both land after the loop's last `trailing` check, inside the run. Expect a second `start`, `idle` after the first `resync`. Today `trailing` is set on a run that has already decided and the second gap is never pulled.
  - `a connect whose intent another entrant took resolves when that completion fails`: `observeDrain` takes the intent first, and `start` rejects only once `begin()` has reached its `finish()` (a gate the test releases). Expect `begin()` to resolve. Today it rejects, because it returns the run still in flight. The completion's failure is `replicaSync`'s to report (see Finding B).
- [ ] **Run; expect FAIL.**
- [ ] **Change:** `finishRun` goes. `completion = coalesce(async () => { deciding = false; if (!deps.isMounted()) return; …before; do { trailing = false; await start(); await idle(); } while (trailing && deps.isMounted()); deciding = true; …after, staleViews, resync }, { merge: () => undefined, joinable: () => !deciding })`. `deciding = true` is the first statement after the loop, in the same synchronous step as its last check. `finish()`: `if (!deps.isMounted()) return Promise.resolve(); if (!intent) return completion.idle(); intent = false; trailing = true; return completion(undefined);`. Setting `trailing` before every call is safe: a starting run clears it, an owed run clears it, and only a joined run reads it. The header's `intent`/`trailing` paragraph names `coalesce` for the gap after the decision.
- **Done:** web gates green; the `a855c43e` pinning tests and every other `reconnectFlow.test.ts` and `session.test.ts` test green unmodified.
- [ ] **Orchestrator:** `proptest/check.sh web --file sync`.

### Task 5: `clientRuntime.repair`

**Implementer:** opus (the live target list, the delete-loop boundary, the success result, the retry reads).

**Files:** `web/src/sync/clientRuntime.ts`, `clientRuntime.test.ts`.

- [ ] **Red tests** in `clientRuntime.test.ts`, `describe("clientRuntime repair and retry")` (the setup gains a way to hold `deleteBatch`):
  - `a poison event after the repair began deleting gets a repair of its own`: rebase resolves, the first `deleteBatch` is held, `emitPoison(second)`, release. Expect two `rebaseAuthoritative(poison)` and `deleteBatch(2,b-2)`. Today the second event is merged into a list the loop has already read, and its row is never deleted.
  - `a repair after a failed one keeps the failed targets`: a run fails, then a new poison event; the next run deletes both rows. Today a fresh run replaces the list, and the failed row stays poisoned while its success releases `poison`. The conversion makes this case reachable through an owed run, so it is fixed here (Question 4).
  - Guard, green before and after: `continueStartup starts the replica when its own repair succeeded, though another is owed`. A naive conversion that reads `repairSucceeded` after the await would fail it.
- [ ] **Run; expect the two red tests to FAIL.**
- [ ] **Change:**
  - `repairRun` goes. `repairOnce = coalesce(runRepair, { merge: mergePoisonEvents, joinable: () => !deleting })`, where `runRepair(events): Promise<boolean>` resolves with whether this run succeeded.
  - `runRepair` begins: `deleting = false; repairTargets = mergePoisonEvents(repairFailed ? repairTargets : [], events); repairSucceeded = false; repairFailed = false; queue.pause("poison"); emit repair-started`. After `await replicaSync.rebaseAuthoritative("poison")`, in the same synchronous step: `deleting = true; const targets = repairTargets;` then the delete loop over `targets`. The rest of the body is unchanged.
  - `repair(events)`: with no events, `Promise.resolve(repairSucceeded)` (today's read of the last run's flag). Otherwise `repairTargets = mergePoisonEvents(repairTargets, events)`, then `return repairOnce(events)`. A joined call's events reach the running run through that list; a starting or owed run resets the list at its start.
  - `continueStartup`: `const ok = await run; if (!ok) return;`. `runRetry` `repair-targets`: `repair(repairTargets).then((ok) => (ok && live() ? replicaSync.start() : undefined))`. `retry-poison-marks` and `retryFailedRepair`: `await repairOnce.idle()` where they awaited `repairRun`. `discardPoisonIntents`: `!repairOnce.running()` where it tested `repairRun === null`.
  - The `ClientRuntime.repair` doc says it resolves after a run that started after the call, or one that had not begun deleting.
- **Done:** web gates green; the pinning tests green unmodified; `git grep -n repairRun web/src/sync/clientRuntime.ts` finds nothing. `props/sync/queueHarness.ts` needs no edit: its stand-in `rebaseAuthoritative` queues a deferred per call, and its `repair` command takes them in turn.
- [ ] **Orchestrator:** `proptest/check.sh web --file sync`.

### Task 6: `legacyRepair.run`

**Implementer:** opus (`stable` per run; laneOwed across an owed run; the retry's wait).

**Files:** `web/src/sync/legacyRepair.ts`, `legacyRepair.test.ts`.

- [ ] **Red test** in `legacyRepair.test.ts`, `describe` of `retryFailed`: `a reconnect during a stable run waits for the owed run and retries it once if it fails`. Run A reaches `onStable`, run(B) arrives (owed), `retryFailed()` is called, A succeeds, the owed run fails. Expect a third attempt from the retry. Today the retry awaits A's promise only, finds `repairFailed` cleared by the owed run's start, and returns. The owed run's failure then waits for the next connect. The interface doc already promises the new behaviour: "A repair still running is awaited first and retried once if it fails" (Question 5).
- [ ] **Run; expect FAIL.**
- [ ] **Change:** `repairRun` goes; `let stable = false`. `repairOnce = coalesce(runRepair, { merge: (_, next) => next, joinable: () => !stable })`. `runRepair(error)`: `stable = false; repairFailed = false;` the message, `legacy-repair-started`, then `repairSessions(onStable)` with `onStable` setting `stable = true` before it emits and resumes, and the same `.catch`. `run(error, desync)`: `rejectedError = error; if (desync?.lane === true) laneOwed = true; return repairOnce(error);`. `retryFailed`: `await repairOnce.idle();` then as now. The header's "a run is single-flight" sentence names `coalesce`.
- **Done:** web gates green; the three `08a534f7` pinning tests green unmodified (the first asserts `second` is `first`: the helper hands joiners the starter's promise).
- [ ] **Orchestrator:** `proptest/check.sh web --file sync`.

### Task 7: A closed socket reports nothing (Finding A)

**Implementer:** sonnet. Independent lane: runs in parallel with any of Tasks 1 to 6.

**Files:** `web/src/sync/socket.ts`, `socket.test.ts`, `useSocketLifecycle.test.ts`.

- [ ] **Red tests:**
  - `socket.test.ts`: `a closed handle reports nothing when its socket's close lands later`. Open the socket, `handle.close()`, advance past the fake's deferred `onclose`; `statuses` stays `[true]`.
  - `useSocketLifecycle.test.ts`: `a StrictMode replay's first socket closing late leaves the session connected`. Open the replayed socket before the first socket's deferred close fires, then let it fire; `session.status()` is still `connected`.
- [ ] **Run; expect FAIL.**
- [ ] **Change:** `close()` detaches the live socket's `onopen`, `onmessage` and `onclose` before `ws.close()`. The resume heuristic's own `ws.close()` keeps them: it relies on `onclose` to reconnect.
- **Done:** web gates green; every other `socket.test.ts` and `useSocketLifecycle.test.ts` test green unmodified.

### Task 8: Docs say what W9 made true

**Implementer:** sonnet (`architecture-docs` skill). Last.

**Files:** `docs/architecture/sync-recovery.md`, `sync-and-offline.md`, `docs/troubleshooting.md`.

- `sync-recovery.md`: the rule stated once, in the place the skill judges owns it (the recovery barrier's neighbourhood is the likely home): a call during a run settles only after a run that could have served it, owned by `sync/coalesce.ts`. A short table gives each site's joinable boundary with its reason. `start`: always, since the run's own pull follows. `pull`: never, since a pass may be past its fetch. `finish`: until the resync decision. `repair`: until the delete loop reads its targets. Legacy: until `onStable`, since a later run read too early. It also states that `opQueue.drain` keeps its own rule and why: the rerun depends on the outcome and the armed retry. The existing sentences that restate the rule point at it: § The recovery barrier, "A rejection that lands after a run's `onStable` gets a run of its own…"; § A batch the server rejects, "a pull that joined it still gets a pass of its own: callers such as the reconnect's trailing pull take a join to mean their pull will run". The latter becomes: a pull owed behind the pass gets its own run.
- `sync-and-offline.md` § The reconnect drain: keep the trailing-pull sentence, and add that a connect landing after the resync decision gets a completion of its own. Add the Finding B sentence: a completion's failure is reported by `replicaSync` (`noteFailure`: the stall count and the backoff retry), not by whichever entrant ran it.
- `troubleshooting.md`: one row for Task 7. Symptom: in development, after StrictMode's effect replay, the sync status reads reconnecting while the socket is open, and edits wait. Cause: `connectSocket`'s `close()` left `onclose` attached, so the replaced socket's late close reported offline. Owner: `sync-and-offline.md` § Ancillary details (the Socket entry). Bean `pkm-p9s2`. One row for each gap the conversions close, keyed by the symptom it would show. Pull and finish: another device's change is missing until the next nudge or reconnect (owner: the new rule's section in `sync-recovery.md`). Repair: a rejected change's row stays until the next page load (owner: § A batch the server rejects). Bean `pkm-p9s2`.
- **Done:** `node .claude/skills/architecture-docs/check-docs.mjs` passes; `lint:comments` green.

## Findings from W8

**A. `socket.ts` `close()` leaves `onclose` attached.** Real. Only `useSocketLifecycle` calls `close()`. On a real unmount the late close reaches a disposed session: `queue.setOnline(false)` on a disposed queue only clears a timer, and `live()` suppresses the report, so it is harmless. Under StrictMode the session survives the replay. If the replayed socket opens before the first socket's close event, that event sets the queue offline and the status to `reconnecting` under an open socket, and nothing delivers until that socket drops. A real development defect, small and red-testable, sharing no file with the coalesce work: Task 7, in W9 (Question 6).

**B. A `replicaSync.start()` failure during reconnect is swallowed via `observeDrain`.** Not a functional defect. `start()`'s own catch calls `noteFailure`, which counts the failure towards the stall banner and arms the backoff retry. A completion that throws skips its resync whoever started it, and `staleViews` survives for the next completion. What the `observeDrain` path loses is one `console.error` line from the session's `begin()` catch. Task 4 makes the intent-less path consistent (it waits through `idle()`, which never rejects), and Task 8 states who reports a failed completion. No code task of its own, and nothing for W10.

## Order and parallel lanes

```
T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> T8
T7 (any time; merge before T8)
```

| File | Tasks | Rule |
|---|---|---|
| `sync/coalesce.ts`, `coalesce.test.ts` | T1; a later task only as its first commit, if the contract proves wrong | report it: a contract change is a plan change |
| `sync/replicaSync.ts`, `replicaSync.test.ts` | T2, T3 | serial |
| `sync/reconnectFlow.ts`, `.test.ts` | T4 | |
| `sync/clientRuntime.ts`, `.test.ts` | T5 | |
| `sync/legacyRepair.ts`, `.test.ts` | T6 | |
| `sync/socket.ts`, `socket.test.ts`, `useSocketLifecycle.test.ts` | T7 | parallel lane |
| docs | T8 | implementers leave docs to T8 and say in their commit what became true |

T4 to T6 share no file with each other, but they run serially: each site's property run must measure that site alone, and the gate is a machine-wide serial resource (port 8978).

## Property gate

The sync suites depend on timing, so a seed does not replay the same example before and after a change. The evidence is the floors, the unfloored tally, and one mutant per site.

1. **Baseline.** After Task 1 merges (no site uses the helper yet), the orchestrator runs `proptest/check.sh web --file sync` and keeps the tallies both suites print.
2. **After each site task** (2 to 6), `proptest/check.sh web --file sync`. The gate judges every floor. Compare the unfloored labels with the baseline and report differences as facts.
3. **Models.** `props/sync/queueModel.ts` models the barrier's owners from `sync-recovery.md` § The recovery barrier; no conversion changes a claim or a release, so no model edit is planned. `props/sync/model.ts` and the oracle model server and replica data, not these internals. If a suite fails after a site, judge the failure against the docs first. A model is edited only where the docs say it is wrong, never to match new code. `queueHarness.ts`'s stand-ins need no edit (Task 5). `harnessClient.ts`'s `Pull joined` tally needs `idle()` identity (Task 1).
4. **A mutant per site** shows the property still notices a lost late caller. Uncommitted, applied to the converted site only, two seeds each with `proptest/check.sh web --file sync --seed <n>`, then reverted. Record which invariant fired, or that none did:

   | Site | Mutant | Expected |
   |---|---|---|
   | `start` | none | every call joins, so no late caller exists to lose; the unchanged `start …` floors are the evidence |
   | `pull` | `joinable: () => true` | a late nudge joins a pass past its fetch. `sync.prop.ts`'s "a nudge joined to a pull left to a poison repair gets its own pass" should fail on its mode check; random examples reach it through the dead-worker `afterPull` check |
   | `finish` | `joinable: () => true` | likely survives: quiesce pulls every client to the latest seq and no rule reads view freshness. The unit tests are the guard |
   | `repair` | `joinable: () => true` | likely survives: in the queue suite the `poison` owner holds delivery during a repair, so no second rejection arrives mid-run |
   | legacy | `joinable: () => true` | a lane rejection after `onStable` joins a run that will not resume `lane` again; the queue suite's delivery invariant should fail at quiesce (reached through `lane rejected after a legacy repair's onStable`) |

   A surviving mutant is a fact about reach, reported with the table. It is not a new rule here (Question 7).
5. **Floors.** None changes in W9 without re-measurement by `reach.ts`'s recipe (`PROPTEST_REACH_LOG`, unseeded runs on a quiet machine, the orchestrator's call), and none is lowered to pass. A floor that fails after a site is first a question: does the label's path depend on that site's internals? `Pull joined` depends on `idle()` identity, so a drop there is a bug in Task 1 or Task 3, not a floor to move. If the path does not depend on the site, it is a finding: investigate before anything else.
6. **Fault warnings:** an `UNEXPECTED` entry in a suite's `fault warnings` line is a finding, never an `EXPECTED_KINDS` addition without that reasoning.
7. **Final:** `proptest/check.sh web` (the whole side) on the final branch.

## Shape left for W10 and W11

- W10 deletes `authoritativeRepair`, `onPoisonPending` and `completeAuthoritativeRepair` and runs `payPoisonPull` on the queue's resume of `"poison"`. `payPoisonPull` still calls `void pull()`, which W9 keeps as the one door to `pullRun`. W10's `orderedPoisonEvents` replaces `mergePoisonEvents` in three places, `repairOnce`'s `merge` among them. W10's `outlineRepair` rename moves `legacyRepair.ts` with its `repairOnce` intact.
- W11 works inside `runRecovery`, whose `awaitInFlightPull` now reads `startOnce.idle()` and `pullRun.idle()`.
- `opQueue.drain` keeps `drainAgain` and the missed-kick re-check; W10's `deliverLeased` does not touch them.

## Traps

- **The gap moved, not removed, if a flag flips late.** `deciding = true` directly after the `do … while`; `deleting = true` and the target read in one step after the rebase's `await`; `stable = true` first in `onStable`. Detect: Task 4's and Task 5's red tests.
- **Reading a shared flag after the await.** The owed run has started by the time a caller resumes. Read the run's result instead. Detect: Task 5's guard test.
- **`idle()` identity.** A fresh `.then(...)` wrapper per call breaks the harness's join detection silently. Detect: Task 1's identity test; the `Pull joined` floor.
- **Microtask counts in pinning tests.** Some tests `await flush()` a fixed number of times. The helper settles callers in the reaction that observes the run, no later than today's `.finally`. A pinning test that fails on timing is reported, never padded with flushes.
- **Unhandled rejections.** `pull()` catches; `start`'s retry timer catches; `observeDrain` catches; `repairOnce` and the legacy `repairOnce` never reject. Detect: vitest.
- **Brand rules, FCIS, comment lint.** `coalesce.ts` is `// pattern: Imperative Shell`, as the epic decided; it imports nothing from `sync/`. Detect: `pnpm lint`, `pnpm check:fcis`, `pnpm lint:comments`.
- **Coverage.** `src/props/**` is excluded; `coalesce.ts` counts only through its own tests and the sites'. Detect: `pnpm test:coverage`.

## Final gates

| Gate | Who |
|---|---|
| Web gates without Playwright | each implementer, per task |
| `proptest/check.sh web --file sync`, steps 1, 2 and 4 above | orchestrator, serially, after Task 1 and after each site task |
| `pnpm verify` including the full Playwright suite | orchestrator, on the final branch |
| `proptest/check.sh web` (whole side) | orchestrator, serially, on the final branch |
| `perf/check.sh frontend` | orchestrator, serially, on a quiet machine, on the final branch before merge. The reconnect completion and the pull are on the frontend's measured paths; a count change is read against this plan's behaviour differences before anything is re-recorded |

## Questions for Arthur

1. **Two reads on the helper.** The epic's signature returns a bare function. Every site also reads its in-flight state elsewhere, through an `idle()` or a "running" test, so without reads no site converts. The plan adds `idle()` and `running()` to the returned callable. Neither changes any call's outcome, so neither is an option on the rule. Recommendation and default: add them.
2. **`pull`: one run per pass.** Converted with `joinable` omitted, each pass becomes its own run. Success and failure are then noted per pass, and `pendingChangedRetries` counts per pass, where today both span a loop of joined passes; the fetch sequence is unchanged. The alternative keeps the `again` loop under `joinable: () => !deciding`, as `finish` does. That is exact, but it keeps the flag `62ef7a41` had to get right. Recommendation and default: one run per pass.
3. **`opQueue.drain` stays hand-written.** Its late kick reruns only on a drained outcome, or on a lifted block with no retry armed, and late `drain()` callers keep the old outcome. The helper's owed call always runs and resolves with the rerun. Expressing that needs a "rerun only if" option, which the epic's stop rule says marks a different pattern. Recommendation and default: leave it, with the reason in `sync-recovery.md`.
4. **A repair after a failed one keeps the failed targets.** Today a fresh run replaces the target list. A failed repair's rows can then stay poisoned while a later repair's success releases `poison`. The conversion makes that reachable through an owed run, so Task 5 fixes it with a red test. Recommendation and default: fix it in Task 5.
5. **Retries wait through an owed run.** `legacyRepair.retryFailed` and `clientRuntime.retryFailedRepair` now await `idle()`, so a connect during a run with a follow-up owed waits for the follow-up and retries it once if it fails. Today they wait for the first run only. That matches the interface docs' "awaited first and retried once if it fails". Recommendation and default: accept, pinned by Task 6's red test.
6. **The `socket.ts` fix in W9 or its own bean.** It shares no file with the coalesce work and is a few lines with two red tests. Recommendation and default: W9, Task 7, parallel lane.
7. **Mutants that survive.** `finish` and `repair` are expected to survive their mutants: the suites never read view freshness, and never deliver a second rejection during a repair. Recommendation and default: one W19 row, "late callers at `coalesce` sites the sync suites do not reach", naming the sites whose mutant survived, with the unit tests named as the current guard.
