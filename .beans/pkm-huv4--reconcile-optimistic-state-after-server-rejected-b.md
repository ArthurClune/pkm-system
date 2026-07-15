---
# pkm-huv4
title: Reconcile optimistic state after server-rejected batches
status: todo
type: bug
priority: critical
tags:
    - web
    - sync
    - data-integrity
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-15T14:23:26Z
parent: pkm-c1cg
---

## Problem

A 4xx response marks a durable batch poisoned, but its optimistic SQLite effects remain visible. SyncProvider does not observe poison events or trigger authoritative repair.

## Scope

Expose rejected-batch state and restore authoritative replica/UI state without reapplying the poisoned operation.

## Acceptance criteria

- [ ] SyncProvider observes and surfaces poison events.
- [ ] Poisoned optimistic effects are rolled back or removed by a guarded authoritative rebase.
- [ ] Later feed/snapshot application does not reapply the poisoned batch.
- [ ] The user receives a recoverable error state instead of silent divergence.
- [ ] Provider-level and replica-level 4xx regression tests are added.
- [ ] pnpm verify passes.
