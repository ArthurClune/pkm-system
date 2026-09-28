---
# pkm-5ekv
title: A durable batch can overtake an older fallback-lane batch (move-before-create 400)
status: completed
type: bug
priority: normal
created_at: 2026-09-28T18:58:39Z
updated_at: 2026-09-28T21:19:24Z
---

iPad 2026-09-28 19:31: the server got a `move` of NeaikGSJ-r3sl3PY whose `create` it never received -> HTTP 400, and the create was lost for good at the 19:40 reload (the lane is in-memory; iOS PWAs ignore beforeunload).

Most likely path (traced from the code, not confirmed by client logs):
1. The create's enqueue failed on the damaged replica (pkm-h1c6), so it was retained in the fallback lane.
2. Its `durableAhead` was over-counted, either by a durable batch that was delivered but whose `deleteBatch` then threw (opQueue.ts deleteBatch catch: no `durableBatchSettled`), later dropped by the reset, or by `countPending` returning a stale cached count.
3. The later `move` persisted durably, and the drain handed it to the server first because the lane head still waited on a phantom predecessor.

opQueue.ts's lane-append comment already accepts this: "until the durable queue is next observed empty ... a batch persisted after it can go out first". This bean questions that acceptance. A move/delete/update of a lane-held create is guaranteed to 400.

Options to weigh:
- Record, per lane entry, the highest durable row id at append time (a new RPC or an enqueue reply field), and deliver the head before any `nextBatch()` whose id exceeds it.
- Once the lane is non-empty, route later enqueues to the lane too, until it drains (durability cost).
- At minimum: count a delivered-then-deleteBatch-failed batch as settled.

## Todo
- [x] Decide the rule (Arthur)
- [x] Failing test: lane create + over-counted durableAhead + later durable move -> move must not post first
- [x] Fix + docs (sync-and-offline § The in-memory fallback lane)


## Rule (decided 2026-09-28)

Offline edits must stay durable, so "route later enqueues to the lane" is out.
Order is decided by **batch identity**, in one place, and the count goes:

- One rule, owned by the queue: a durable batch this queue persisted while the
  lane was non-empty follows every lane entry appended before it. Any other
  durable row (previous session, the offline shim's create_page) is ahead of
  the lane. An empty durable queue releases the lane. batch_id survives a
  replica file replacement (pkm-1b2w copies rows as they are).
- One door: `deliverLaneAhead(batchId)` delivers the lane entries a batch
  follows. The drain calls it for each batch it pulls; the recovery flush
  (`replicaSync.flushBatches`) calls it before each leased batch. That flush was
  a second overtaking path the original analysis missed.
- `durableAhead`, `durableSinceFallback`, `durableBatchSettled`,
  `clearDurablePrecedence` and the append-time `countPending()` are removed.
  Cost: the lane now needs a `nextBatch()` read to go, so a transient read
  failure delays it through the normal backoff (never loses it).


## Summary of Changes

- `web/src/sync/opQueue.ts`: lane order is decided by batch identity. A
  durable batch persisted while the lane held entries gets a `follows` mark
  (the lane-append boundary); `laneHeadPrecedes(batchId | null)` is the one
  predicate; `settleLaneHead` shifts a head only if it is still at the front.
  New `OpQueue.deliverLaneAhead(batchId)` posts the lane entries a batch
  follows and never discards. Removed `durableAhead`, `durableSinceFallback`,
  `durableBatchSettled`, `clearDurablePrecedence` and the append-time
  `countPending()`.
- `web/src/sync/replicaSync.ts`: `flushBatches` calls
  `queue.deliverLaneAhead(b.batch_id)` before each leased batch (the second
  overtaking path).
- Tests: bean scenario (delivered-but-undeleted predecessor dropped out of
  band), recovery-flush call order, `deliverLaneAhead` order/failure/dispose/
  race, unmarked rows ahead, transient `nextBatch` failure. The pkm-yavj test
  keeps its ordering property; the dispose-during-countPending test went with
  the RPC it raced.
- Docs: sync-and-offline § The in-memory fallback lane (ordering table and
  the "every durable-posting path asks the queue" invariant); one
  troubleshooting row.
- Verified: `pnpm verify` (2666 unit, 62 e2e) green; `perf/check.sh`
  frontend: no changes against the baseline.
