# Replica availability: one owner, everything derived

Date: 2026-08-04
Epic: pkm-q2jj
Status: approved (design only — no code yet)

## Problem

"Is the replica usable?" is encoded in five places, kept in sync by convention:

| # | Representation | Where |
|---|---|---|
| 1 | `init().ok` | `replica/workerHandlers.ts` |
| 2 | the memoised `dbPromise` resolved/rejected state — the actual truth | `replica/workerHandlers.ts` |
| 3 | `disabled` ("permanent for this session") | `sync/replicaSync.ts` |
| 4 | `replicaState.mode === "no-replica"` | `sync/SyncProvider.tsx` |
| 5 | `isSahPoolContention` / `isPoolExhausted` **message matching** | `sync/opQueue.ts` |

Number 5 is the alarming one: whether the user's writes survive is decided by
matching strings in an error message.

Every open follow-up from pkm-bjae is a consumer re-deriving this fact locally
and getting it slightly wrong:

- **pkm-9x6u** — the whitelist, not the availability state, decides survival.
- **pkm-4ubd** — `update_text` loses `base_text_hash`, and with it conflict
  protection, because the hash is stamped inside the DB path.
- **pkm-tu5k** — the poison mark intent clears only via a successful DB write,
  so an unopenable profile is wedged in *every future session*.
- the `probe === "unknown"` branch — the gate is retained, but no availability
  state is ever set, so nothing downstream knows.

pkm-bjae itself had the same cause. `init()`'s failure path cleared the memoised
open, so the viability probe re-armed access to a database it had just declared
dead; the barrier lift then drained an unexamined durable queue. Two reviewers
read that mechanism **identically** and drew opposite conclusions — one called
"`init()` is the only call that genuinely retries" a virtue, the other showed it
was the hole. Nothing in the code recorded which purpose it served, and cause
(`workerHandlers.ts`) sat three modules from effect (a drain kicked via
`queueState.ts`). That is the diagnosis: not unreadable code, a missing concept.

## The fact has two levels

The single most important design decision, and a refinement to the approved
sketch. Two consumers need this fact for different purposes, at different
evidentiary bars:

- **Retaining an op** needs only "this write did not persist locally."
- **Lifting the recovery barrier** needs "there is positively no poison table to
  read", because delivering past an unrepaired rejection is the ordering hazard
  the barrier exists for (see pkm-bjae).

So the fact is a two-value enum, not a boolean:

| Value | Meaning | Retain ops? | May lift the barrier? |
|---|---|---|---|
| `unusable` | `openDb()` failed — there is definitively no database | yes | **yes** |
| `unreachable` | the worker/RPC is terminally broken — we could not ask | yes | **no** |

This is what lets `RpcLifecycleError` (dead worker, module chunk 404 after a
deploy, RPC timeout) close pkm-9x6u's second half — its ops are retained rather
than dropped — *without* lifting a barrier on the strength of "we couldn't ask",
which the pkm-bjae review correctly identified as not evidence of anything.

## Design

### 1. The worker owns it

`buildHandlers` latches `unavailable: ReplicaUnavailableError | null`, set the
first time `openDb()` fails. Every handler rejects with it.

This *replaces* pkm-bjae's latch rather than adding to it. That latch worked by
leaving the memoised `dbPromise` rejection in place — correct, but implicit: its
safety depended on a reader noticing that `init()` must not clear a promise
three modules from where the consequence lands. The new latch says what it
means. `close()` remains the only reset.

### 2. A typed error carries it

The wire error shape gains `unavailable` beside `quota`. This follows an
existing, documented precedent — `rpc.ts:4`, *"Errors cross as {message, quota}
so the storage-quota signal survives"*; `serveRpc` reads the boolean off the
thrown error (`rpc.ts:72`) and the client reconstructs a typed error
(`rpc.ts:108`). We are adding a second flag to a mechanism that already works,
not inventing transport.

`ReplicaUnavailableError extends ReplicaError`, so every existing
`instanceof ReplicaError` check keeps working.

**The wire flag is a boolean even though the fact is two-valued, and that is
correct:** only `unusable` ever crosses the wire, because it is the worker
reporting its own failed open. `unreachable` is by definition the case where
nothing can cross — it is *generated client-side* by the RPC layer
(`RpcLifecycleError`: worker-error, message-error, timeout, disposed). So the two
levels come from two different places and must be combined on the main thread,
not in the wire shape. Writing this down because a single `unavailable: boolean`
that tried to carry both would be exactly the kind of quiet conflation this
whole epic exists to remove.

**Required detail:** `replicaSync`'s `isStallShaped` is one such check, and an
unavailable error must **not** count toward the stall threshold — otherwise a
session reports `stalled` on top of `no-replica`, and `computeEditability` can
flip a whole offline session read-only.

### 3. Everything else derives, or is deleted

| Consumer | After |
|---|---|
| `opQueue` | retains on **type**. Deleted: message matching on this path |
| `replicaSync` | derives state from the typed error. Deleted: `disabled` boolean |
| `SyncProvider` | learns it from `poisonedBatches()`'s typed rejection. Deleted: the `init()` probe, the `"unknown"` branch, `markUnavailable()` |
| `OfflineIndicator` | unchanged banner, rendered off derived state |

Deleting `markUnavailable()` does not lose the explicit session-commitment
moment that made pkm-bjae comprehensible — it **moves** it to the worker latch,
where the commitment actually happens.

### 4. How each bean closes

- **pkm-9x6u** — retention keys off type, covering both the no-replica case and
  the `RpcLifecycleError` case an availability *mode* alone would miss.
- **pkm-tu5k** — the queue can see that marking is impossible, so its policy
  becomes an explicit decision instead of an emergent permanent wedge.
- **pkm-4ubd** — `base_text_hash` is always stamped main-thread at op
  construction; `replica/queue.ts` already defers when the hash is present, so
  this is additive.
- the `"unknown"` branch stops existing: it becomes `unreachable`, which retains
  ops and holds the barrier — the correct behaviour, by construction.

## Risk

This removes three load-bearing things (the probe, the `disabled` boolean, the
message whitelist) from the code path behind five past incidents: pkm-c9hp,
pkm-ndcu, pkm-hhbc, pkm-wi25, pkm-bjae. That is the strongest argument against
doing it, and it was accepted deliberately.

**Mitigation — characterise before refactoring.** Every behaviour to be
preserved gets a test that passes on *today's* code first: the latch, the
retain-vs-desync split, the barrier lift, the exit-1 gate, the banner, the
`no-replica` mode transition. Only then does the implementation change, with
those tests as the net.

Any behaviour that *cannot* be pinned against today's code is a behaviour nobody
has ever verified — record it as a finding rather than quietly preserving it.

## Ordering

One branch, reviewable commits:

1. `ReplicaUnavailableError` + the `unavailable` wire flag (no consumers yet)
2. characterisation tests against current behaviour
3. the worker latch, replacing pkm-bjae's implicit one
4. `opQueue` retention by type; delete the message whitelist on that path
5. `SyncProvider` / `replicaSync` derivation; delete the probe, `disabled`,
   `markUnavailable()`, the `"unknown"` branch
6. `base_text_hash` main-thread stamping (pkm-4ubd)
7. docs: `sync-and-offline.md`, and prune what the deletions make obsolete

pkm-tu5k is deliberately **not** in that list — see below. This branch makes its
fix possible without deciding it.

## Open question deferred to implementation

pkm-tu5k's *policy* is not settled by this design. Making the fact explicit lets
the queue know marking is impossible; it does not decide what to do about a
rejection that can never be repaired on a profile whose replica never opens.
Candidates recorded in that bean: repair through the server without the replica,
or let the user explicitly discard an intent they can never mark. Read-only was
already ruled out. This design should land without pre-empting it.

## Testing

- Worker-level: the latch, and that no handler reopens after it.
- `opQueue` unit: retention by type, for both `unusable` and `unreachable`.
- Provider: the barrier lift for `unusable`, the barrier *held* for
  `unreachable`, the banner, the exit-1 gate.
- The two reproduction tests already recorded in pkm-9x6u and pkm-4ubd go green
  as part of this and become permanent pins.
- Full `pnpm verify` (typecheck, enforced coverage, Playwright e2e) per CLAUDE.md.

## Addendum: two refinements found during implementation (2026-08-04)

1. **The retain rule is a one-item blocklist, not a two-value type check.**
   Section 3's table said `opQueue` "retains on type", meaning `unusable` /
   `unreachable`. That would have regressed pkm-ndcu: `isPoolExhausted`
   (`SQLITE_CANTOPEN`) fires on writes to a successfully OPEN database, so it is
   not an availability failure and would have fallen through to `onDesync`.
   The rule shipped is: retain every replica failure **except** one the replica
   reports as a rejection of the op itself (`LocalOpError` -> the `rejected`
   wire flag). This is what pkm-9x6u's own scope correction asked for, and it
   needs one extra wire flag rather than a whitelist.
2. **"Unreachable" retains at every level but latches only on permanent
   evidence.** `createRpcClient` latches its terminal state for `worker-error`,
   `message-error` and `disposed`, but a timeout rejects one request and leaves
   the client usable. So `isSessionFatal` gates whether a consumer may cache the
   availability state; `availabilityOf` alone gates retention.
