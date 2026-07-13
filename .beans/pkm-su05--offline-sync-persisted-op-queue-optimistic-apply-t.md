---
# pkm-su05
title: 'Offline sync: persisted op queue + optimistic apply + TS refs + page-id reconciliation'
status: completed
type: task
priority: normal
created_at: 2026-07-12T17:38:43Z
updated_at: 2026-07-13T19:13:02Z
parent: pkm-y8p0
blocked_by:
    - pkm-gtov
---

Spec step 4 (sections 2-3): pending op queue persisted in the replica DB as wire-format JSON (pending_ops(id, batch_id, ops_json), additive changes only - guardrail: schema recovery reads this before any teardown and never rebootstraps with a non-empty queue); batch_id + base_text_hash captured at enqueue; optimistic replica application; TS port of refs.py parity-tested against Python fixtures; negative-id page reconciliation via defer_foreign_keys transaction. Needs its own written plan.

## Summary of Changes

Implemented on codex/pkm-offline-web:
- refs.ts + daily.ts TS ports, parity-pinned by shared/fixtures/refs_parity.json (generator refs_parity_dump.py + server guard test).
- localOps.ts: optimistic application of all 7 op kinds to the replica (sibling shifts, cross-page subtree moves, deepest-first deletes, local ref reindex); offline-created/implicit pages get distinct negative temp ids; batches apply atomically.
- queue.ts: pending_ops persisted queue — wire-format JSON with batch_id; base_text_hash captured per update_text from the replica's current text BEFORE optimistic apply (edit chains flush cleanly, incl. within one batch); poison lifecycle (4xx set aside with error, skipped by nextBatch, still visible to recovery).
- reconcile.ts: negative-id page reconciliation inside the deferred-FK window transaction (children/refs remapped incl. PK-collision merge, no cascade delete, local-only blocks survive).
- opQueue.ts rewritten: replica-backed pump (durable batches, batch_id dedup, poison continues the queue, network errors retry on reconnect, quota errors surface + degrade to direct post online); legacy in-memory path preserved verbatim for no-replica mode.
- SyncProvider: canEdit/pending/readOnlyReason context (offline editing enabled when replica ready; quota-exhausted-offline freezes editing with a reason); useOutline readOnly now !sync.canEdit; reconnect ordering flush→pull→resync.
530 unit tests green, coverage 98% stmts.
