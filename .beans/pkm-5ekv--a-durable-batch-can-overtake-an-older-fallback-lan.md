---
# pkm-5ekv
title: A durable batch can overtake an older fallback-lane batch (move-before-create 400)
status: todo
type: bug
created_at: 2026-09-28T18:58:39Z
updated_at: 2026-09-28T18:58:39Z
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
- [ ] Decide the rule (Arthur)
- [ ] Failing test: lane create + over-counted durableAhead + later durable move -> move must not post first
- [ ] Fix + docs (sync-and-offline § The in-memory fallback lane)
