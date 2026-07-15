---
# pkm-qvqz
title: Make replica recovery atomic with concurrent enqueues
status: todo
type: bug
priority: critical
tags:
    - web
    - sync
    - data-integrity
created_at: 2026-07-15T14:22:42Z
updated_at: 2026-07-15T14:22:42Z
parent: pkm-c1cg
---

## Problem

Replica recovery checks and flushes pending operations before reset, but enqueue RPCs can run concurrently between that check and the reset. An accepted edit can therefore be persisted and then erased.

## Scope

Coordinate replicaSync recovery, worker RPC dispatch, and enqueue persistence so recovery owns an exclusive reset window.

## Acceptance criteria

- [ ] Enqueues are gated or serialized while recovery/reset is active.
- [ ] Persistence is drained and pending work is rechecked immediately before reset.
- [ ] No acknowledged enqueue can be erased by reset.
- [ ] A deterministic enqueue-versus-reset concurrency regression test is added.
- [ ] Existing schema-mismatch and rebootstrap behavior remains covered.
- [ ] pnpm verify passes.
