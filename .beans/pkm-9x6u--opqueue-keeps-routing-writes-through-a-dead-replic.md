---
# pkm-9x6u
title: opQueue keeps routing writes through a dead replica in a no-replica session
status: todo
type: bug
priority: low
created_at: 2026-08-04T11:52:14Z
updated_at: 2026-08-04T12:08:05Z
---

Found in review of pkm-bjae. Pre-existing mechanics, but that fix makes them the steady state of a normally-working session instead of a symptom of a wedge, which is why they are worth addressing now.

pkm-bjae makes a session whose replica cannot be opened fall back to online-only and keep running indefinitely. `opQueue` is not told about that: it still calls the replica on every drain.

**1. Every drain ends in `failed`, so `resyncSeq` stops being bumped.** Once the in-memory fallback lane empties, the drain loop falls through to `replica.nextBatch()` (opQueue.ts around the durable-batch step), which rejects -> `failed()` -> a ~5 s backoff retry, forever. Cheap in itself (the worker memoises the rejected `dbPromise`, so there is no repeated OPFS open), but `drain()` never returns `drained`, so `finishReconnect` in SyncProvider never runs. After a drop/reconnect, views are therefore never told to refetch: changes made elsewhere while this tab was disconnected can stay invisible until the user navigates.

**2. The storage-error whitelist becomes load-bearing for the whole session.** The retain-vs-desync classifier only retains ops for quota / SAH contention / pool exhaustion; anything else fires `onDesync`, whose legacy repair rebases the active outline to server state. pkm-bjae's own failure shape is whitelisted (which is why the fix works), but a session now runs indefinitely against a dead replica, so any unwhitelisted error shape from that replica would rebase the user's outline mid-session.

Both point the same way: tell `opQueue` the replica is unavailable (retain unconditionally, skip the RPC entirely) rather than having it rediscover this on every drain via a rejected call.

## Checklist

[ ] Give opQueue a no-replica mode (set when SyncProvider calls markUnavailable)
[ ] In that mode: skip the durable-batch RPCs, retain fallback ops unconditionally, and let drain() reach `drained` so finishReconnect runs
[ ] Cover: a reconnect in a no-replica session must bump resyncSeq
[ ] Cover: an unwhitelisted replica error in a no-replica session must not trigger onDesync
[ ] Check whether the ~5 s retry loop should stop entirely in that mode


## Third symptom (from pkm-bjae adversarial review)

**A non-contention unopenable cause loses the edit by a different route.** The fallback lane only admits ops whose error is whitelisted (quota / isSahPoolContention / isPoolExhausted). If the replica is unopenable for a reason OUTSIDE that whitelist -- wasm init failure, OPFS unavailable in private browsing -- `replica.enqueue` throws unclassified, the ops are dropped, and `onDesync` fires, whose legacy repair rebases the active outline to server state. So pkm-bjae's online-only fallback only actually rescues the contention flavour; the flavour its own comment cites as the model (OPFS unavailable) still loses the edit and additionally wipes the active outline.

pkm-bjae's fix depends on the latched open preserving the ORIGINAL error identity for exactly this reason. That is fragile: it means the whitelist, not the no-replica state, decides whether writes survive. Giving opQueue an explicit no-replica mode fixes all three symptoms at once.

[ ] Cover: an unopenable replica whose failure is NOT whitelisted must still retain ops, not fire onDesync


## Premise note (important if actioning this bean)

Symptom 1's premise -- "the worker memoises the rejected dbPromise, so there is no repeated OPFS open, but drain() never returns `drained`" -- is true **only because pkm-bjae latches the failed open** (commit 0156328 removed the `dbPromise = null` from init()'s catch). Before that commit the premise was false in a way that mattered: the viability probe destroyed the memo, so the drain that `resume("recovery")` kicks performed a genuinely fresh open with a fresh retry budget, succeeded in the reload race, and drained the stale durable queue including batches behind an unrepaired poisoned row.

So do not "fix" this bean by re-arming the open to make drain() succeed. The forever-failing drain is the SAFE behaviour; the goal is to stop asking the dead replica at all (an explicit no-replica mode in opQueue), not to make the asking work.
