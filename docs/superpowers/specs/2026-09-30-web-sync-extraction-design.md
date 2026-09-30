# Web sync extraction pass (pkm-xwb5)

Agreed with Arthur 2026-09-30. The last child of epic pkm-a4t2. Source
findings: `docs/2026-09-29-sync-subsystem-review-consolidated.md`
§ Maintainability and its `opQueue.ts` row.

## Problem

The server's sync code is split into pure parts: one classifier, one
text-edit predicate, one replay hash. The web side took each fix as another
branch inside an existing closure.

- `web/src/sync/opQueue.ts` (871 lines) is one closure holding the
  poison-intent localStorage, the listeners, pending-count publication, lane
  ordering (`follows`, `seq`, `laneHeadPrecedes`), lane delivery, the durable
  rejection-to-poison protocol, `runDrain` and enqueue retention. The
  ack's "skipped, so tell the view" check is copied at three delivery sites.
- `createOpQueue(replica, onDesync, onDrain, onSkipped)` and
  `ReplicaSyncDeps.onSkipped` are constructor callbacks, bridged in
  `SyncProvider.tsx` through late-bound refs (`drainObserverRef`, which
  `useSocketLifecycle` also writes, and `skippedRef`).
- `web/src/sync/replicaSync.ts` (862 lines) defines its failure
  classifiers inline: `isStallShaped` and `isWindowFailure` at module
  level, `isFreshCorruption` as a closure over `rebuiltForCorruption`.
- `web/src/replica/localOps.ts` `applyOne` decides where a `create` or
  `move` lands in the middle of the SQL that carries it out, interleaved
  with the replay rules (`keepSlot`, re-paging a replayed create).
- "unavailable" means two things. In the worker, the RPC error shape and
  the UI it means a failed open (`ReplicaUnavailableError`, which
  `availabilityOf` maps to `"unusable"`). In `opQueue` it is the umbrella
  for either `ReplicaAvailability` value. `errors.ts` describes the type in
  invented terms ("the availability fact", "evidentiary levels").

## Outcome

Someone new can read `opQueue.ts`, `replicaSync.ts` and `localOps.ts`
without the bean log. The ordering, classification and placement rules each
live in a Functional Core file with their own unit tests.

**No behaviour changes.** Existing tests take mechanical edits only
(constructor arguments become `onX` subscriptions, renamed identifiers). An
assertion that has to change is a stop-and-report, not an edit.

## Scope

| Part | In |
|---|---|
| Ordered-outbox core out of `opQueue.ts` | yes |
| Constructor callbacks become listeners; `drainObserverRef` and `skippedRef` go | yes |
| Classifiers out of `replicaSync.ts` | yes |
| Availability vocabulary: one word per meaning | yes |
| Pure `placementFor`, tight form | yes |
| Typed ack reader | already shipped (`sync/opsAck.ts` `readOpsAck`) |
| The ack's `applied` count including skipped ops | no; still Arthur's call, not a bean |

## Module map after the pass

| File | Pattern | Role |
|---|---|---|
| `sync/outbox.ts` (new) | Functional Core | Lane ordering state and its transitions (below) |
| `sync/poisonIntents.ts` (new) | Functional Core | Validate, dedupe, sort and merge poison-mark intents (`validPoisonEvent`, the `rowId`/`batchId` key, the sort) |
| `sync/poisonIntentStore.ts` (new) | Imperative Shell | `readPoisonMarkIntents` / `writePoisonMarkIntents` over localStorage (key `pkm.poison-mark-intents.v1`, unchanged) |
| `sync/listeners.ts` (new) | Functional Core | The `listeners<T>()` helper with its listener isolation, shared by `opQueue` and `replicaSync` |
| `sync/syncFailures.ts` (new) | Functional Core | `isStallShaped`, `isWindowFailure`, `isFreshCorruption(error, alreadyRebuilt)`, and `PullStarvedError`, which `isStallShaped` needs |
| `replica/placement.ts` (new) | Functional Core | `placementFor` (below) |
| `sync/opQueue.ts` | Imperative Shell | Enqueue retention, `runDrain`, the rejection-to-poison protocol, `WriteTicket` promises and resolvers, timers; composes the cores |
| `sync/replicaSync.ts` | Imperative Shell | Imports the classifiers; `onSkipped` becomes a listener |
| `replica/localOps.ts` | Imperative Shell | `applyOne` asks `placementFor` for `create` and `move`, then runs the SQL |
| `sync/SyncProvider.tsx`, `sync/useSocketLifecycle.ts` | Imperative Shell | Subscribe to the queue and replicaSync in effects |

## The outbox core

`sync/outbox.ts` holds the lane's ordering data as a value:

- entries `{ batchId, ops, seq }` in append order;
- `laneAppended`, the monotonic source of each entry's `seq`;
- `follows`, batch id → the lane boundary that durable batch waits behind.

Its transitions are pure and return the next state, in the style of
`queueState.ts`:

| Transition | Today's code |
|---|---|
| `append(state, batchId, ops)` | the `fallback.push` + `laneAppended += 1` in enqueue's catch |
| `markFollows(state, batchId)` | `if (fallback.length > 0) follows.set(batchId, laneAppended)` |
| `headPrecedes(state, batchId \| null)` | `laneHeadPrecedes` |
| `settleHead(state, batchId)` | `settleLaneHead`'s shift-if-still-head and `follows.clear()` on empty |
| `forget(state, batchId)` | `follows.delete` after delivery or rejection |
| `clearMarks(state)` | `follows.clear()` when `nextBatch()` sees the durable queue empty |

Promise resolvers stay out of the core. The shell keeps a map of batch id to
resolver for lane entries, beside the existing `deliveries` map for durable
batches. `settleHead` is keyed by batch id, never by object identity, so the
race between the drain and `deliverLaneAhead` delivering the same head keeps
its rule: settling twice is harmless, shifting twice is not.

`opQueue.ts` keeps one `noteCommitted(ack)` helper for the three delivery
sites (lane head, durable batch, `deliverLaneAhead`): read the ack, fire
`onSkipped` if it names a skip, return the reading.

## Callbacks become listeners

- `createOpQueue(replica)` takes no callbacks. `OpQueue` gains `onDesync`,
  `onDrain` and `onSkipped`, built with `listeners()` like `onPoison`.
- `ReplicaSync` gains `onSkipped(fn)`; `ReplicaSyncDeps.onSkipped` goes.
- `SyncProvider` subscribes `onDesync` and both `onSkipped`s in effects.
  `useSocketLifecycle` subscribes `onDrain` in its own effect, in place of
  writing `drainObserverRef`. `drainObserverRef` and `skippedRef` go.
  `repairLegacyRef` goes too if the startup continuation that also calls it
  can use a stable `useCallback`; otherwise it stays, with a comment saying
  why.

**Why no event can arrive before its listener.** The ref bridge is live from
the first render, while an effect subscription exists only after the commit.
React runs a commit's passive effects in one synchronous flush, children
before parents. Every emission from the queue and from replicaSync happens
after at least one `await`: persist runs on `persistChain` in a microtask,
and delivery waits on a POST. So all subscriptions are in place before any
emission can run.

That rule goes in `opQueue.ts`'s header comment, and a test pins it:
`enqueue`, `drain`, `setOnline`, `pause` and `resume` never emit to
`onDesync`, `onDrain` or `onSkipped` synchronously.

## Classifiers

`sync/syncFailures.ts` takes the three predicates with their doc comments.
`isFreshCorruption` captures only `rebuiltForCorruption`, so its pure form
is `isFreshCorruption(error, alreadyRebuilt)`, and `replicaSync` passes its
flag. `PullStarvedError` moves with `isStallShaped`, and `replicaSync`
imports it from there. Each predicate gets a table-driven unit test over
the error kinds it separates (`ApiError`, `OfflineError`, `ReplicaError`,
`ReplicaUnusableError`, `RpcLifecycleError`, `PullStarvedError`, corruption,
a plain `Error`).

## `placementFor`

`replica/placement.ts`, for `create` and `move` only. It absorbs their
`skipsOnMissingTarget` call; the other op kinds keep calling
`skipsOnMissingTarget` directly.

```ts
placementFor(op: CreateOp | MoveOp, facts: {
  block: { page_id: number; parent_uid: string | null; order_idx: number } | null;
  parent: { page_id: number } | null;
  parentChain: readonly string[];
  titlePageId: number | null;
}, reapply: boolean): Placement

type Placement =
  | { kind: "skip" }
  | { kind: "keep"; repageTo: number | null }
  | { kind: "place"; page: { id: number } | { title: string };
      parentUid: string | null; orderIdx: number; repage: boolean };
```

| Op and state | Verdict |
|---|---|
| any, `skipsOnMissingTarget` true | `skip` |
| `create`, `reapply`, row exists | `keep`; `repageTo` is the parent's page when the row still sits under that parent and the parent is on another page, else `null` |
| `create`, otherwise | `place` on the parent's page if the parent is live, else `{ title: op.page_title }`; `repage: false`. An existing uid still fails the INSERT, as the server 400s |
| `move`, `reapply`, already at its target page, parent and `order_idx` | `keep`, `repageTo: null` |
| `move`, otherwise | `place` on the parent's page, else the title page, else the block's own page; `repage` when that page differs from the block's |

`titlePageId` is the id of an existing page titled `op.page_title`, which
the shell looks up without creating the page. It exists because today a
replayed move with a title calls `getOrCreateLocalPage` before deciding
whether the block is already in place, and a pure function cannot create a
page. If no such page exists, the block cannot already be on it, so the
verdict is `place` with `{ title }` and the shell creates the page as it
does today. A create under a live parent still never creates its title page
(`placement_cases` `pages_absent`).

`applyOne` keeps the SQL: `keepSlot`, `shiftSiblings`, the INSERT/UPDATE,
the subtree re-page loop, `reindexRefs`, `touchPage`.

## Vocabulary

`unusable` becomes the only word for a failed open. `unavailable` stops
being an identifier.

| Today | After |
|---|---|
| `ReplicaUnavailableError` (and its `name`) | `ReplicaUnusableError` |
| RPC error field `unavailable: boolean` (`replica/rpc.ts`) | `unusable` |
| worker latch `let unavailable` (`replica/workerHandlers.ts`) | `unusable` |
| problem kind `replica-unavailable` (`syncState`, `retryPolicy`, `OfflineIndicator`) and `ReplicaUnavailableBanner` | `replica-unusable`, `ReplicaUnusableBanner` |
| `opQueue`'s `let unavailable: ReplicaAvailability \| null` | `availability` |

- UI copy is unchanged ("offline editing is unavailable for now").
- The RPC field crosses only between the page and a worker built from the
  same bundle, so the rename has no compatibility cost.
- `errors.ts` and `docs/architecture/sync-recovery.md` drop "availability
  fact" and "evidentiary levels" and keep the two-row table.
- The bean's six distinctions (a draft's base identity; failed delivery
  versus rejected intent; acknowledged versus still-optimistic; a replica
  with optimistic edits is not a clean copy; leased rows are not durable
  rows; replica convergence versus view refresh) are the words to use where
  this pass names something. No type exists only to carry one.

## Invariants the pass must keep

- The order in both stamping choke points: stamp before the optimistic
  apply (`opQueue.ts` `deferDurableQueue` comment, `replica/queue.ts`).
- `// pattern:` headers on every runtime file, and `pnpm check:fcis` green.
- `emitPending` stays the only writer of the published pending counts.
- Identity-based lane ordering: a durable batch with no `follows` mark is
  ahead of the lane.
- `deliverLaneAhead` never discards; a discard is the drain's decision.
- The missed-kick re-check after `runDrain` settles.
- The retention blocklist is one item: `ReplicaError.rejected === true`.

## Testing

- New unit tests: `outbox.ts` (each transition, and the drain-versus-
  `deliverLaneAhead` double settle), `poisonIntents.ts`, `syncFailures.ts`,
  `placement.ts` (one test per verdict row), and the no-synchronous-emit
  test.
- `placement_cases` gains a row for each `placementFor` branch the fixture
  does not reach yet, at least a replayed move already at its target. Rows
  run through the real `applyLocalOps` on the web and `test_ops_core.py` on
  the server.
- Existing suites (`opQueue.replica.test.ts`, `replicaSync.test.ts`,
  `SyncProvider.test.tsx`, `useSocketLifecycle.test.ts`, `localOps.test.ts`,
  `missingTarget.test.ts`) take mechanical edits only.
- `pnpm verify`, server `pytest`, and `perf/check.sh frontend` before merge.

## Delivery

One feature branch, `feat/pkm-xwb5-sync-extraction`. Order:

1. The vocabulary rename. It touches the most files, so the rest branch
   from it.
2. In parallel worktrees: the outbox core (with `poisonIntents`,
   `poisonIntentStore`, `listeners`, `noteCommitted`); the classifiers;
   `placementFor`.
3. The listener conversion, after the outbox and classifier tasks, since it
   touches both files.
4. Docs: the `frontend.md` module map, `sync-and-offline.md`,
   `sync-recovery.md`, through the architecture-docs skill.

Whole-branch review on the strongest model. Deploy after merge; the pkm-67j1
and pkm-amw9 changes, already on `main`, go out with it.
