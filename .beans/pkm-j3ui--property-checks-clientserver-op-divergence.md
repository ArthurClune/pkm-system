---
# pkm-j3ui
title: 'Property checks: client/server op divergence'
status: todo
type: feature
priority: normal
created_at: 2026-10-02T10:57:25Z
updated_at: 2026-10-03T16:46:30Z
parent: pkm-nws9
---

Random op sequences applied by the server and by the replica (applyLocalOps) and in-memory tree (applyOpInPlace) give the same tree. Cross-language, likely via a generated fixture or the protocol harness. Needs its own brainstorm/spec.

Note from the sync harness (pkm-yxcs): its single-client mode could compare the optimistic replica before a pull with the server after the ack, which checks client/server op divergence for the sync stack's own optimistic apply without a new fixture.
