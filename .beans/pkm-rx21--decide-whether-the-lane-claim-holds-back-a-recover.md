---
# pkm-rx21
title: Decide whether the lane claim holds back a recovery's leased flush
status: todo
type: task
created_at: 2026-11-11T17:29:10Z
updated_at: 2026-11-11T17:29:10Z
---

The queue property (props/sync/queue.prop.ts), once its recovery stand-in flushed through OpQueue.deliverLeased, found a recovery's leased POST starting while the barrier's lane owner held. Shrunk: edit(writeFails, bad); edit(ok, bad); respond(ack); recoveryStart; recoveryFlush; respond(ack) -> 'barrier: leased durable q-2 posted while lane held'. deliverLeased runs under the caller's recovery claim and does not consult the barrier, and replicaSync's preemptible beforePost stops only for poison (sync-recovery.md § A batch the server rejects). sync-recovery.md § The recovery barrier says the lane claim holds from a lane entry's 4xx until the next outline repair is stable, but gives it no rule over a recovery's flush. Decide: should a leased flush also stop (or skip) while lane holds, or is posting durable rows during an outline repair harmless? queueModel.ts's barrier rule currently judges leased POSTs against poison only; change it with the decision. Found in pkm-ygyx part (b).
