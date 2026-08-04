---
# pkm-q2jj
title: Replica availability has five representations and no owner
status: completed
type: epic
priority: normal
created_at: 2026-08-04T12:53:17Z
updated_at: 2026-08-04T16:58:21Z
---

"Is the replica usable?" is currently encoded in five places, kept in sync by convention:

1. `init().ok` — the reported value
2. the worker's memoised `dbPromise` resolved/rejected state — the actual truth
3. `replicaSync`'s `disabled` boolean — "permanent for this session"
4. `replicaState.mode === "no-replica"` — what the UI sees
5. `opQueue`'s storage-error whitelist (`isSahPoolContention` / `isPoolExhausted`) — which decides whether the user's writes SURVIVE, by matching error message strings

All four open follow-ups from pkm-bjae are the same bug wearing different clothes -- a consumer re-deriving this fact locally and getting it slightly wrong:

- **pkm-9x6u** — the message whitelist, not the availability state, decides whether writes survive
- **pkm-4ubd** — conflict protection is lost because `base_text_hash` is stamped inside the DB path
- **pkm-tu5k** — the poison intent can only clear via a successful DB write, so an unopenable profile wedges every future session
- the `probe === "unknown"` branch — the gate is retained but no availability state is ever set

pkm-bjae itself was caused by the same gap: `init()`'s failure path cleared the memoised open, so a viability probe re-armed access to a database it had just declared dead, and the barrier lift then drained an unexamined durable queue. Two independent reviewers read that mechanism IDENTICALLY and drew opposite conclusions about whether it was a virtue or a defect -- because nothing in the code recorded which purpose it served, and the cause and effect were three modules apart.

Design: `docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md`.

Approach approved 2026-08-04: the worker owns the fact, a typed error carries it across the RPC boundary (following the existing `quota` flag precedent documented at `rpc.ts:4`), and every other representation is DERIVED or deleted -- including SyncProvider's `init()` probe, `markUnavailable()`, `replicaSync`'s `disabled` boolean, and the message-matching whitelist.

Full refactor in one branch, landed as reviewable commits. Child beans below.


## Children

Sequenced (see the design's Ordering section):
1. **pkm-y35i** — typed error + wire flag (no consumers)
2. **pkm-imw4** — characterise current behaviour FIRST; this is the regression net
3. **pkm-za9j** — the explicit worker latch, replacing pkm-bjae's implicit one
4. **pkm-s7af** — opQueue retains by type; deletes the message whitelist (closes pkm-9x6u)
5. **pkm-61zt** — derive in SyncProvider/replicaSync; delete the probe, `disabled`, `markUnavailable()`, the `"unknown"` branch
6. **pkm-4ubd** — main-thread `base_text_hash` stamping

**pkm-tu5k is adopted as a child but deliberately NOT sequenced into this branch.** Making the fact explicit is what lets the queue know marking is impossible; it does not decide what to do about a rejection that can never be repaired. That policy call stays open (read-only is already ruled out).


## HANDOVER (2026-08-04, end of session)

Next step: **writing-plans for this epic.** The design is approved; no implementation plan exists yet. Read the spec first: `docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md`.

### Repository state

- Branch **`pkm-replica-availability`** @ `bc482ec` — docs + beans ONLY, no code. Pushed.
- `main` @ `41702d9`. **Prod @ `f24230f`** (bundle-verified). The two are different only by a beans-only commit, which does not ship.
- Working tree clean. Nothing in flight, no subagents running.

### Shipped earlier today (all closed, all live in prod)

- **pkm-wi25** — the block-stamps "flake" was real data loss: sqlite-wasm memoises `installOpfsSAHPoolVfs` rejections, so the OPFS open-retry replayed its first error without re-touching OPFS. Fixed with `forceReinitIfPreviouslyFailed: true`.
- **pkm-apr7** — jsdom navigation noise. Needs a CAPTURE-phase listener inside an interactive island (bubble never reaches document because the island calls stopPropagation). `web/src/test-setup.ts` now FAILS the run on any jsdom "Not implemented:" output.
- **pkm-bjae** — an unopenable replica falls back to online-only instead of wedging the op queue's startup gate.

### Non-obvious things you must not rediscover the hard way

1. **The fact is two-valued.** `unusable` (openDb failed) may lift the recovery barrier; `unreachable` (terminal RPC failure — dead worker, chunk 404, timeout) must NOT, because "we could not ask" is not evidence there is no poison. Both retain ops.
2. **The wire flag is a boolean and that is correct** — only `unusable` crosses the wire; `unreachable` is generated client-side. Do not try to make one boolean carry both.
3. **pkm-imw4 (characterise first) is a hard prerequisite**, not a nicety. This epic deletes three load-bearing things from the path behind pkm-c9hp, pkm-ndcu, pkm-hhbc, pkm-wi25, pkm-bjae. Tests must pass on TODAY's code before anything changes.
4. **The latch invariant:** the worker's `db()` is `dbPromise ??= openDb()`. One failed open must stay latched for the session; only `close()` may re-arm. `init()`'s catch used to clear it, which let a viability probe re-arm the DB it had just declared dead — that WAS pkm-bjae's bug, introduced by pkm-bjae's own first fix.
5. **`isStallShaped` must not count an unavailable error** (`replicaSync.ts`), or a session reports `stalled` on top of `no-replica` and `computeEditability` can flip it read-only.
6. **There is NO `beforeunload` anywhere in `web/src`.** Anything that reloads or resets must account for the in-memory fallback lane, or undelivered ops die silently.
7. **`base_text_hash` is stamped inside the worker** (`replica/queue.ts`), so any op bypassing the DB loses conflict protection and the server falls through to plain LWW.
8. **`resume()` is a boolean, not a counter** (`queueState.ts`) — barrier ownership is not modelled. Latent; no concurrent holder on today's paths, but it bites if the lift ever moves.
9. **The reproduction tests in pkm-9x6u and pkm-4ubd are NOT in the suite** — their key assertions assert the FIXED behaviour and would break CI. Land them green as part of each fix.

### Verify

`cd web && pnpm verify` (typecheck + enforced coverage + Playwright e2e). Baseline on `main`: 122 files / 1972 tests, coverage 97.7% stmts / 93.09% branch, 51/51 e2e, 0 jsdom warnings. Never use port 8974 (prod launchd service owns it). Deploys: `CI=true ~/.config/pkm/app/deploy/update.sh` only, then grep the SERVED bundle.

### Why this epic exists

Two independent reviewers read the same memoisation mechanism, described it identically, and drew opposite conclusions about whether it was a virtue or a defect. That is the symptom of a missing concept, not of unreadable code — and cause sat three modules from effect.

## PLAN WRITTEN (2026-08-04)

docs/superpowers/plans/2026-08-04-replica-availability-single-owner.md — eight
tasks, one per commit, in the design's order (61zt split across two: the
ReplicaInit.ok sweep, then the markUnavailable/disabled deletion).

Two design refinements found while writing it, recorded in the plan's
"Findings" section and to be appended to the spec in Task 8:

1. **The retain rule must be a one-item blocklist, not a two-value type check.**
   isPoolExhausted (SQLITE_CANTOPEN) fires on writes to a successfully OPEN
   database, so it is NOT an availability failure; retaining only on
   unusable/unreachable would drop it through to onDesync and regress pkm-ndcu.
   opQueue retains every replica failure EXCEPT one the replica reports as a
   rejection of the op itself (LocalOpError -> a new `rejected` wire flag).
   This is what pkm-9x6u's own scope correction asks for.
2. **Only session-fatal evidence may latch an availability state.**
   createRpcClient latches `terminal` for worker-error/message-error/disposed,
   but a timeout rejects one request and leaves the client usable. Every level
   retains; only permanent evidence caches a state. Hence isSessionFatal
   alongside availabilityOf.

Also decided: **ReplicaInit.ok is deleted** (representation #1 of the design's
table). Once every handler rejects with the latch, an init() that resolves
always has ok:true. Fixture churn is mechanical and typecheck finds every site.

Third finding, recorded for pkm-imw4 rather than fixed: **nothing in web/src
ever throws an error carrying quota:true** — the flag is set only by tests, so
the quota -> onQuota -> read-only chain is unverifiable end-to-end today.

## Summary of Changes

The worker latches a ReplicaUnavailableError on the first openDb() failure and
every handler rejects with it; it crosses the wire via two new flags on the
existing {message, quota} shape; every other representation is derived or gone.
Deleted: init().ok, replicaSync's `disabled`, markUnavailable(), SyncProvider's
init() viability probe and its "unknown" branch, and opQueue's
isSahPoolContention/isPoolExhausted message matching. Closed pkm-9x6u (both
halves, including the RpcLifecycleError case an availability mode alone would
have missed) and pkm-4ubd (base_text_hash stamped main-thread).

Two design refinements are recorded as a spec addendum: the retain rule is a
one-item blocklist rather than a two-value type check (a pool-exhausted write on
an OPEN database is not an availability failure, and a type check would have
regressed pkm-ndcu), and only session-fatal evidence may latch an availability
state (an RPC timeout is not terminal).

pkm-tu5k remains OPEN and unsequenced by design: this branch makes its fix
possible — the queue can now see that marking is impossible — without deciding
what to do about a rejection that can never be repaired.
