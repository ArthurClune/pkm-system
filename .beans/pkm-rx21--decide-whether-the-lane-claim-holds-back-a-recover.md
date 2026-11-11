---
# pkm-rx21
title: Decide whether the lane claim holds back a recovery's leased flush
status: completed
type: task
priority: normal
created_at: 2026-11-11T17:29:10Z
updated_at: 2026-11-11T19:18:18Z
---

The queue property (props/sync/queue.prop.ts), once its recovery stand-in flushed through OpQueue.deliverLeased, found a recovery's leased POST starting while the barrier's lane owner held. Shrunk: edit(writeFails, bad); edit(ok, bad); respond(ack); recoveryStart; recoveryFlush; respond(ack) -> 'barrier: leased durable q-2 posted while lane held'. deliverLeased runs under the caller's recovery claim and does not consult the barrier, and replicaSync's preemptible beforePost stops only for poison (sync-recovery.md § A batch the server rejects). sync-recovery.md § The recovery barrier says the lane claim holds from a lane entry's 4xx until the next outline repair is stable, but gives it no rule over a recovery's flush. Decide: should a leased flush also stop (or skip) while lane holds, or is posting durable rows during an outline repair harmless? queueModel.ts's barrier rule currently judges leased POSTs against poison only; change it with the decision. Found in pkm-ygyx part (b).


## Decision (Arthur, 2026-11-11)
Option (b): a recovery's leased flush (OpQueue.deliverLeased) may post while the lane claim holds.
Reason: the claim only orders the ordinary drain behind the outline repair, which rewrites no queued op, so a row's outcome is the same posted then or later; a leased POST settles no ticket. Stopping the flush would turn a manual reset into ResetBlockedError over an unrelated repair.


## Summary of Changes
- opQueue.replica.test.ts: a deliverLeased test pins posting under a lane claim (claim held, ticket unresolved, resolves delivered after resume and a drain that finds the row gone); fails when deliverLeased refuses under lane.
- sync-recovery.md § The recovery barrier states the rule and its reason; queueModel.ts header points to it.
- Side finding filed as pkm-3ono.
