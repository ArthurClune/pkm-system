---
# pkm-bjae
title: A permanently unopenable replica wedges startup and strands edits in memory
status: completed
type: bug
priority: normal
created_at: 2026-08-04T10:46:28Z
updated_at: 2026-08-04T12:20:53Z
---

Found while fixing pkm-wi25.

If the replica's OPFS SAH pool can never be opened (a second live tab holding the handles, an OS-level OPFS lock -- anything the bounded retry in openRetry.ts cannot outlast), SyncProvider's mount effect never lifts its startup gate: it calls queue.setOnline(false) + queue.pause("recovery") and then awaits queue.retryPoisonMarks() and replica.poisonedBatches(), both replica RPCs. On failure it dispatches poison-discovery-failed and returns, so the queue is never resumed and never set online.

Observed consequence (measured in the e2e harness before the pkm-wi25 fix, by holding the pool contended): the editor still accepts edits and renders them, the op queue retains them in the ordered in-memory fallback lane, and NOTHING is ever POSTed -- for at least 60 s, indefinitely in practice. The only signal is the banner "Checking rejected changes failed: <error>" with a Retry button, which does not say that unsaved work is at stake. A reload or a closed tab loses those edits silently and permanently.

pkm-wi25 removed the common trigger (sqlite-wasm's memoised install rejection defeating the retry), so this is no longer reachable from a transient navigation race. It is still reachable whenever the holder is persistent.

Worth deciding between:
- letting the fallback lane drain while the startup gate is up (the poison check protects against posting AHEAD of an unrepaired rejected batch -- with no openable replica there are no such rows to protect, so the barrier may be vacuous in this state)
- making the state visibly unsafe instead: say that changes are not being saved, and/or go read-only rather than accept edits that cannot be delivered
- a beforeunload guard while the lane is non-empty

## Checklist

[x] Decide the policy (drain-anyway vs refuse-edits vs warn-on-unload)
[x] Reproduce deterministically in a unit test against SyncProvider with a replica whose open always rejects
[x] Implement and cover
[x] Update docs/architecture/sync-and-offline.md (the paragraph pkm-wi25 added about this hazard)


## Summary of Changes

Policy: **online-only fallback, not read-only** (decided with Arthur 2026-08-04). The app already shipped this degradation for wasm/OPFS-unavailable via `init()` returning `ok: false`; this change makes it reachable rather than inventing a new policy. Read-only was rejected because same-origin tabs contend for one OPFS pool, so a routinely-open second tab would be read-only as a matter of course.

Root cause of the unreachability: `init()` is the only handler that reports a `db()` failure as a value (workerHandlers.ts:170), but it runs inside `start()`, which is the LAST line of `continueStartup` (SyncProvider.tsx). `poisonedBatches()` queries the replica first with an uncaught `await db()` (workerHandlers.ts:218), so a permanent open failure dead-ended startup with `pause("recovery")` still held. Only the pause is durable -- `setOnline` self-corrects from socket status.

Changes:
- `sync/SyncProvider.tsx` -- on discovery failure with no mark intents, probe `init()` for viability; if not viable, `markUnavailable()` + `resume("recovery")` and return.
- `sync/replicaSync.ts` -- new `markUnavailable()` (sets the session's permanent `disabled` flag + reports `no-replica`). Deliberately NOT `await start()`: if that start's `init()` happened to succeed, the session would resume delivery with poison discovery skipped -- reintroducing the ordering hazard as part of the fix.
- `sync/SyncProvider.test.tsx` -- two new tests (online-only delivery; the exit-1 pin below). Also amended "startup discovery failure without fallback is visible and retryable": its `initCalls === 0` assertion was pinning "did not start syncing", which the probe changes without changing intent, so it now asserts one probe call plus no `applySnapshot`.
- `sync/replicaSync.test.ts` -- `markUnavailable` is permanent even if a later `init()` would succeed.
- `docs/architecture/sync-and-offline.md` -- rewrote the hazard paragraph pkm-wi25 added; it described the old dead-end behaviour.

Deliberately out of scope, split to **pkm-tu5k**: when `retryPoisonMarks()` fails with intents present, a rejected batch is KNOWN to exist and the gate correctly stays up -- but edits still strand silently behind a banner that only says a check failed. A test pins that asymmetry so it cannot be "fixed" by accident.

Residual risk accepted: a stale holder (crashed tab, OS-level lock) means nobody repairs a hidden poisoned row and this change posts ahead of it. Needs a prior crash between marking and repair; consistent with the risk the OPFS-unavailable path already takes.

Verified: `cd web && pnpm verify` exit 0 -- 122 files / 1964 tests, coverage 97.69% stmts / 93.12% branch, 51/51 e2e, 0 jsdom warnings. Each new test was watched failing first; the two behaviour-pinning tests were proved to have teeth by temporarily breaking the code they guard.


## Review follow-up (2026-08-04)

Code review found two real test problems, both fixed on this branch:

1. **The `markUnavailable()` vs `start()` decision was NOT pinned.** Verified by mutation: swapping `markUnavailable()` for `await start()` left all 83 tests green. The replicaSync-level test covers the method in isolation, which cannot catch a provider that stops calling it. Added "a replica that becomes openable later must not start syncing" (SyncProvider.test.tsx) — fails under that mutation with `expected 'ready' to be 'no-replica'`, i.e. the session really does start syncing with discovery skipped.
2. **The amended test had one toothless assertion and had lost a real one.** `expect(replica.log).not.toContain("applySnapshot")` could never fail: the fake's init returns `empty: false, schemaMismatch: false`, so doStart skips both bootstrap() and recover(). Replaced with `replicaMode === "starting"`, and restored the deleted post-retry assertion as `initCalls === 2` + `replicaMode === "ready"` so a Retry that re-discovers without syncing is caught.

Also from review:
- `resetLocalData` is now gated on `disabled` (replicaSync.ts). It sets `started` and forces mode "ready", which would undo markUnavailable()'s permanence. No UI path reaches it today, so this guards a future UI change.
- Two comments asserted the fixed bug still exists and are corrected: `openRetry.ts`'s SAH_POOL_INSTALL_OPTIONS rationale and `sync-and-offline.md`'s "silently undeliverable rather than merely uncached". Dropping the flag now costs the cache and offline reads, not durability.
- Split to **pkm-9x6u**: opQueue still calls the dead replica every drain, so drain() never reaches `drained` and finishReconnect never runs (views stop refetching after a reconnect), and the storage-error whitelist becomes load-bearing for a whole session.

Re-verified: `pnpm verify` exit 0 — 1966 tests, coverage 97.69% stmts / 93.13% branch, 51/51 e2e, 0 jsdom warnings.


## Adversarial review found a real hole — fixed (2026-08-04)

A second reviewer, tasked with refuting the safety argument rather than reviewing the code, found that the first implementation of this fix **introduced the very hazard the barrier exists to prevent**. Reproduced in the repo's own harness before fixing.

`db()` is `dbPromise ??= deps.openDb()` (workerHandlers.ts:63), so one failed open is memoised and replayed to every handler -- but `init()`'s catch CLEARED `dbPromise`. So the viability probe re-armed the database it had just reported unopenable. `queue.resume("recovery")` then emits a kick whose drain calls `nextBatch()` -> a fresh `openDb()` with a fresh retry budget -> succeeds in the reload race -> the session drained durable batches, including any queued behind an undiscovered poison row, having never read the poison table. Test evidence before the fix: `posts` contained `queued-behind-poison`.

Fix: delete that `dbPromise = null`. One failed open now latches the database shut for the session (only `close()` re-arms), which also preserves the memoised error's identity so opQueue's storage-error whitelist still retains ops in the fallback lane. Pinned in `workerHandlers.test.ts` ("a failed open stays latched") -- NOT at provider level, because a provider test's replica double is the very worker it would be asserting about, which is why the first attempt at that test failed to catch it.

Also tightened: only an explicit `ok: false` lifts the barrier. `.catch(() => false)` had treated a REJECTING probe (dead worker, broken RPC, timeout) as proof no database exists; it only means we could not ask, so that case keeps the gate and its Retry banner.

**The spec's central justification was also refuted and is corrected in place.** It claimed the app already shipped "deliver anyway with an unreadable DB" via `init().ok === false`. That path was unreachable in the worker-backed app: `init()`'s only pre-existing call site is in `doStart()`, reached only after `poisonedBatches()` succeeded -- and a successful discovery means the memoised open resolved, so `init()` could not then report `ok: false`. An OPFS-less browser wedged on the gate too. This change RESTORES a dead path rather than inheriting an accepted risk from it. The decision to prefer online-only over read-only still stands on the two-tab argument.

Third symptom added to pkm-9x6u: a non-whitelisted unopenable cause still loses the edit and wipes the active outline via onDesync.

Re-verified: `pnpm verify` exit 0 -- 1968 tests, coverage 97.69% stmts / 93.14% branch, 51/51 e2e.

## Still open for a decision (not fixed here)

Committing to online-only is **silent**: `no-replica` maps to no `problem`, so no banner renders and `resetReplica` is unreachable. Before this branch, the same transient contention produced a `poison-discovery` banner WITH a Retry that could restore full offline capability once the other tab closed. So this fix trades a visible-but-wedged session for a working-but-silently-degraded one: the user loses offline editing for the session with no notice and no affordance. Needs Arthur's call on whether to surface it.


## Residual-risk correction (adversarial review, follow-up)

The spec's original residual-risk statement -- that a poisoned row with no localStorage intent needs "a crash between marking and repair" -- was too narrow, and is corrected in the spec. The window opens when *marking* succeeds (opQueue.ts:330 clears the intent) and closes only when the row is deleted (SyncProvider.tsx:283). Between them sits `rebaseAuthoritative("poison")`, including a full /api/sync/snapshot download. Any non-success route leaves the row poisoned with no intent: a failed snapshot fetch (likeliest -- poison is caused by a server 4xx, so the population is exactly clients the server just rejected), a throw partway through the deleteBatch loop (no per-row error handling), a worker-side snapshot apply failure, or the tab closing mid-download. And there is NO automatic retry: after repair-failed, repairRunRef clears and only the banner's manual Retry re-arms.

Why this does not change the verdict on this branch: the latch bounds it. With the database shut for the session, the durable queue behind that poisoned row is never read and never drained; only this session's in-memory fallback ops are delivered, and those were made against server state. The residual exposure is that a LATER session which does open the DB flushes that stale queue, whose unguarded delete/move/insert ops are LWW. That hazard pre-exists this change; this change means more of the user's work sits in its path.


## Second adversarial pass (2026-08-04) — verdict: safe to merge, one condition, now fixed

The latch was attacked from six directions and held: every handler routes through the memoised `db()`, `close()` is the only re-arm and is immediately followed by `worker.terminate()`, `createReplica`/`new Worker` appear once each behind a guard, `resetLocalData` is guarded, and the offline gateway refuses when mode !== "ready". Ordering inside the lift also held (the block is synchronous; a concurrent connect's drain is blocked by `terminalReason` = "recovering"; double-clicking Retry converges on an idempotent path).

Fixed on this branch in response:
- **Reload could silently discard undelivered work.** `location.reload()` destroys the in-memory fallback lane -- the only place an online-only session's undelivered ops live -- and there is NO beforeunload anywhere in web/src. The banner's own wording invited the click. Now routed through `useConfirm` with the count ("N unsent changes have not reached the server yet. Reloading now discards them." / "Discard and reload"), mirroring resetReplica's refusal.
- **Banner copy was false in some states.** "Your changes are still being saved" only holds for the error shapes opQueue retains for (quota / SAH contention / pool exhaustion). Outside that whitelist the ops are dropped, so the reassurance is removed; the copy now says only what is always true.
- **`replica-unavailable` had no precedence rule.** It was the only problem event in syncState.ts that set unconditionally, so it stomped a failed `legacy-rejected` repair -- and with it the Retry that reaches repairLegacyRef, stranding that repair. It now yields to any other problem kind, matching replica-stalled.

Recorded, not fixed here:
- **pkm-4ubd (new):** in an online-only session NOTHING is conflict-guarded, including `update_text`. base_text_hash is stamped inside the worker, so fallback-lane ops arrive without it and the server falls through to plain LWW -- a concurrent edit from the replica-owning tab is overwritten instead of preserved as a `[[conflict]]` sibling. This is the cost of the two-tab argument that justifies the online-only decision.
- **pkm-9x6u re-triaged low -> normal:** a non-whitelisted open failure still drops writes entirely (reproduced: POSTS [], PENDING 0, canEdit true, and the legacy repair wipes the active outline). Pre-existing, but this branch ships a banner adjacent to it, so the false-reassurance risk is higher.
- **pkm-tu5k re-triaged low -> normal:** exit 1 is STICKY, not transient. The localStorage intent clears only after a successful markPoisoned against the database, so an unopenable profile is wedged in every future session with no escape.
- The `"unknown"` probe branch (rejecting init keeps the gate) is reachable via a chunk-404-after-deploy, where Retry can never succeed. Left as-is: keeping the gate is correct, and the alternative is delivering past unread poison.
