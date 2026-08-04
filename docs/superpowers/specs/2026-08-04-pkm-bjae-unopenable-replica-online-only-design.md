# pkm-bjae: an unopenable replica falls back to online-only

Date: 2026-08-04
Bean: pkm-bjae
Status: approved

## Problem

When the replica's OPFS SAH pool cannot be opened at all, the op queue's
startup gate never lifts. The editor keeps accepting edits, those edits sit in
the ordered in-memory fallback lane, and nothing is ever POSTed. A reload or a
closed tab loses them silently. The only signal is the banner "Checking
rejected changes failed: <error>" with a Retry button, which does not mention
that unsaved work is at stake.

Measured in the e2e harness while holding the pool contended: no delivery in
60 s, indefinitely in practice.

### Why the existing degradation does not fire

The app already has a designed online-only fallback, and it is unreachable in
exactly the case it was written for:

1. `init()` (`web/src/replica/workerHandlers.ts:170`) is the only handler that
   catches a `db()` failure. It returns `{ ok: false, ... }`.
2. `replicaSync.doStart` (`web/src/sync/replicaSync.ts:314`) turns `ok: false`
   into `disabled = true` + `onState({ mode: "no-replica" })` — online-only.
3. But `init()` runs inside `start()`, and `start()` is the **last** line of
   `continueStartup` (`web/src/sync/SyncProvider.tsx:330`).
4. `continueStartup` first calls `replica.poisonedBatches()`
   (`SyncProvider.tsx:309`), whose handler does an **uncaught** `await db()`
   (`workerHandlers.ts:218`).

So a permanent open failure rejects at step 4, hits the `return` on
`SyncProvider.tsx:316`, and `start()` never runs. `init()` never runs. The
`ok: false` path is dead code down this route.

### What actually holds the queue

The startup effect (`SyncProvider.tsx:340-341`) sets both `setOnline(false)`
and `pause("recovery")`. Only the pause is durable: `setOnline` is driven by
socket status at `SyncProvider.tsx:464`, so it self-corrects on the next
connect. (Edge case: a connect landing *before* the mount effect leaves the
online half stuck too, since line 340 overwrites it.) The three sites that
lift the pause are lines 198, 292 and 328; line 328 is the relevant one, and
the failure path never reaches it.

### Where poison actually lives

Two places, which is what makes the risk assessment tractable:

- Retained **mark intents**: `localStorage` (`web/src/sync/opQueue.ts:54`),
  readable without the replica.
- Actually **poisoned rows**: the replica DB
  (`pending_ops WHERE poisoned != 0`) — unreadable when the open fails.

`retryPoisonMarks()` returns `[]` *without touching the replica* when there
are no intents (`opQueue.ts:305-308`), so the usual wedge point is
`poisonedBatches()`, not `retryPoisonMarks()`.

Because marking clears the localStorage intent once the DB becomes the source
of truth (`opQueue.ts:327-331`), the genuinely dangerous state — a poisoned row
we cannot see and hold no intent for — requires a previous session to have
crashed between marking and repairing, *and* the replica to be unopenable now.

## Decision

Fall back to **online-only**, not read-only.

**Correction (adversarial review, 2026-08-04).** The original rationale here was
that the app already ships "deliver anyway with an unreadable DB" via
`init().ok === false`, so this change merely made an existing policy reachable.
**That precedent does not exist.** `init()`'s only pre-existing call site is in
`doStart()`, reached only via `start()`, which startup calls *after*
`poisonedBatches()` has succeeded — and a successful `poisonedBatches()` means
the memoised open resolved, so `init()` could not then report `ok: false`. No
app code calls `replica.close()` to reset it. An OPFS-less browser therefore
wedged on the poison-discovery gate too; it did not degrade gracefully. So this
change *restores* a path that was dead, rather than inheriting an accepted risk
from it — which argues the fix is necessary, but gives its risk no cover.

The decision stands on its remaining ground: same-origin tabs contend for one
OPFS pool, so a read-only policy would make a routinely-open second tab
read-only as a matter of course.

Read-only was rejected. With two or more tabs open routinely (the primary
user's normal pattern), tabs of the same origin contend for the same OPFS
pool, so the non-owning tab would become read-only as a matter of course — a
daily tax to guard a compound rare case.

The two-tab case is also the safest instance: the DB is held by another *live*
tab, which is itself syncing and repairing its own poison. The tab that cannot
open the DB has no business repairing it.

## Scope

Two failure states, treated differently.

### In scope — exit 2: `poisonedBatches()` fails with no intents

No evidence of a rejected batch exists. This is the everyday second-tab case.
Go online-only.

In `continueStartup`, before concluding "unknown repairable state", probe
whether there is a replica at all. `init()` is the one call that answers
"unopenable" as a value rather than an exception:

```ts
} catch (error: unknown) {
  if (marked.length === 0) {
    const viable = await replicaRef.current!.init()
      .then((r) => r.ok).catch(() => false);
    if (!viable) {
      startupDiscoveringPoisonRef.current = false;
      replicaSync!.markUnavailable();  // commit the session to online-only
      queue.resume("recovery");        // lift the gate: nothing to protect
      return;                          // deliberately does NOT call start()
    }
    applySync({ type: "poison-discovery-failed", ... });  // unchanged
    return;
  }
  // marked.length > 0: unchanged, see below
}
```

Cost: one extra `init()` RPC, only on the already-broken path. `init()` is a
read plus `installSchema` when fresh, so a second call is harmless.

### `markUnavailable()` — why the probe result must be committed

The obvious sketch (`await replicaSync!.start()` on the not-viable path, letting
its own `init()` re-derive `ok: false`) has a hole: if the probe fails but
`start()`'s `init()` then *succeeds*, the session would resume the gate with
poison discovery **skipped entirely** — the exact ordering hazard the gate
exists to prevent, reintroduced by the fix.

So `ReplicaSync` gains one method:

```ts
/** Commit this session to online-only after startup determined the replica
 *  cannot be opened. Mirrors the `init().ok === false` path. */
markUnavailable(): void;   // sets disabled = true; onState({ mode: "no-replica" })
```

This is airtight because `disabled` is already "permanent for this session"
(`replicaSync.ts:105`) and `start()` returns early on it (`replicaSync.ts:336`),
so every later call — including the reconnect flow's — no-ops. No path can
later begin syncing with discovery skipped.

### The probe must not re-arm the access it reports impossible

Found by adversarial review, after the first implementation shipped this bug:
`db()` is `dbPromise ??= deps.openDb()` (`workerHandlers.ts:63`), so a failed
open is memoised and replayed to every handler — but `init()`'s catch **cleared
`dbPromise`**. The probe therefore re-armed the database it had just reported
unopenable, and `queue.resume("recovery")` emits a `kick` whose drain calls
`replica.nextBatch()` → a *fresh* `openDb()` with a fresh retry budget. In the
reload race that succeeds, so the session drained durable batches — including
any queued behind an undiscovered poison row — having never read the poison
table. Reproduced end-to-end before the fix.

The fix is to delete that `dbPromise = null`: one failed open now latches the
database shut for the session, and only `close()` re-arms it. That is what makes
`no-replica` mean what it says, and it preserves the memoised error's *identity*,
so `opQueue`'s storage-error whitelist still recognises the contention shape and
retains ops in the fallback lane rather than treating them as a desync.

Pinned by `workerHandlers.test.ts`, "a failed open stays latched" — the
provider-level test cannot pin it, because a provider test's replica double
*is* the worker it would be asserting about.

### Only an explicit `ok: false` lifts the barrier

`.catch(() => false)` on the probe treated a *rejecting* `init()` (dead worker,
broken RPC port, timeout) as proof that no database exists. It is not: it means
we could not ask. Such a probe now keeps the gate and its Retry banner.

**Why probe rather than have `poisonedBatches` catch its own `db()` failure:**
that handler would have to return `[]`, which asserts *"there is no poison"* —
a lie, and precisely the lie to avoid. `init()` already has the honest
vocabulary for "there is no database".

### Out of scope — exit 1: `retryPoisonMarks()` fails with intents present

Reachable only when `localStorage` holds mark intents, i.e. a batch was
rejected in a previous session and marking did not complete. Here a rejected
batch is **known** to exist and cannot be repaired, so going online-only would
post ahead of a known-bad batch.

Behaviour is unchanged: the gate stays up and the Retry banner shows. That
leaves edits stranded in this rare state, which is a real (smaller) instance of
the same hazard — filed as a follow-up bean rather than fixed here. Read-only
is not the intended remedy for it either; the likely answer is an honest
signal that work is not being saved.

## User-visible behaviour

The second tab behaves like any online-only session: edits post straight to
the server, no local replica cache, no banner. Identical to opening PKM in a
browser without OPFS support today.

Reads in that tab remain online-only — this change does not give a non-owning
tab a local cache.

## Testing

Unit level, in `web/src/sync/SyncProvider.test.tsx`, which already has the
replica-double harness:

1. A replica double whose `poisonedBatches` rejects and whose `init` resolves
   `{ ok: false }`: assert the recovery pause is lifted and queued ops reach
   `/api/ops`.
2. The inverse — `poisonedBatches` rejects but `init` resolves `{ ok: true }`:
   assert today's `poison-discovery-failed` Retry banner still appears and the
   gate stays up, so the anomaly path does not silently regress.
3. `retryPoisonMarks` rejecting with intents present: assert unchanged
   behaviour (gate retained), pinning the out-of-scope decision.
4. After the not-viable path, a later `replicaSync.start()` (as the reconnect
   flow issues) must not begin syncing — the regression test for the
   `markUnavailable()` hole above.

No e2e run is required; the wedge is a startup-ordering property observable in
unit tests. Full `pnpm verify` still gates the branch.

## Residual risk

A *stale* holder — a crashed tab or OS-level lock with no live owner — means
nobody repairs a hidden poisoned row, and this change would post ahead of it.
That needs a prior crash between marking and repair plus a dead-but-locking
holder. Accepted, and consistent with the risk the OPFS-unavailable path
already takes.

## Docs

`docs/architecture/sync-and-offline.md` gained a paragraph in pkm-wi25
describing this hazard ("That lane assumes the replica comes up eventually").
It must be updated: the startup gate no longer holds indefinitely for an
unopenable replica, and the remaining case is exit 1.
