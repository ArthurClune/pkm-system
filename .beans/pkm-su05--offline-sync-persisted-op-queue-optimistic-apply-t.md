---
# pkm-su05
title: 'Offline sync: persisted op queue + optimistic apply + TS refs + page-id reconciliation'
status: todo
type: task
created_at: 2026-07-12T17:38:43Z
updated_at: 2026-07-12T17:38:43Z
parent: pkm-y8p0
blocked_by:
    - pkm-gtov
---

Spec step 4 (sections 2-3): pending op queue persisted in the replica DB as wire-format JSON (pending_ops(id, batch_id, ops_json), additive changes only - guardrail: schema recovery reads this before any teardown and never rebootstraps with a non-empty queue); batch_id + base_text_hash captured at enqueue; optimistic replica application; TS port of refs.py parity-tested against Python fixtures; negative-id page reconciliation via defer_foreign_keys transaction. Needs its own written plan.
