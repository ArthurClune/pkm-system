---
# pkm-j5lt
title: opQueue test-fake hygiene follow-ups from pkm-w5gf reviews
status: todo
type: task
priority: low
created_at: 2026-08-18T13:55:14Z
updated_at: 2026-08-18T13:55:14Z
---

Small non-blocking residue from the pkm-w5gf final whole-branch review (2026-08-18):

- [ ] Pin orphan-ticket settlement: one test that enqueues a durable ticket, flushes replica.rows out-of-band (recovery flush/rebase shape), drains, and asserts ticket.delivered resolves delivered (covers the pendingCount===0 and batch===null finishAllDeliveries paths in web/src/sync/opQueue.ts)
- [ ] memReplica.deleteBatch on a missing id splices the LAST row (findIndex -1); real queue.ts is a no-op — add a one-line guard (web/src/sync/memReplica.ts)
- [ ] Optional: consolidate the ~9 lane-forcing enqueue-override duplicates and gatedFetch's hand-rolled deferred/fetchSeq in web/src/sync/opQueue.replica.test.ts
- [ ] Optional: memReplica.enqueue records a row for empty ops where queue.ts skips the insert (unreachable via the queue) — note or fix
