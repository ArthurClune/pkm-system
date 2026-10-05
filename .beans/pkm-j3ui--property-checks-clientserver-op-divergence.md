---
# pkm-j3ui
title: 'Property checks: client/server op divergence'
status: todo
type: feature
priority: normal
created_at: 2026-10-02T10:57:25Z
updated_at: 2026-10-05T17:47:12Z
parent: pkm-nws9
---

Random op sequences applied by the server and by the replica (applyLocalOps) and in-memory tree (applyOpInPlace) give the same tree. Cross-language, likely via a generated fixture or the protocol harness. Needs its own brainstorm/spec.

Note from the sync harness (pkm-yxcs): its single-client mode could compare the optimistic replica before a pull with the server after the ack, which checks client/server op divergence for the sync stack's own optimistic apply without a new fixture.

## Progress 2026-10-05

Spec, plan and Tasks 1-6 done on feat/pkm-j3ui-op-divergence. First runs found: A (property, fixed: check S), B/D/E replay != first apply incl. pkm-sj5l proper (→ replay rebase, spec docs/superpowers/specs/2026-10-05-replica-replay-rebase-design.md approved), C (accepted transient, excluded), F (open page loses an off-and-back block: fixed b1e59fd8), G (paste title refusal: tallied). Next: rebase plan. Handover: docs/superpowers/handoffs/2026-10-05-property-checks-handover-4.md
