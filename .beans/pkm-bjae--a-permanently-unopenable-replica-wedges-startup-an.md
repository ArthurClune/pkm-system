---
# pkm-bjae
title: A permanently unopenable replica wedges startup and strands edits in memory
status: completed
type: bug
priority: normal
created_at: 2026-08-04T10:46:28Z
updated_at: 2026-08-04T11:53:36Z
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
