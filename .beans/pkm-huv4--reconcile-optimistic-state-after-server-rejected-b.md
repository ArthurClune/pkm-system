---
# pkm-huv4
title: Reconcile optimistic state after server-rejected batches
status: completed
type: bug
priority: critical
tags:
    - web
    - sync
    - data-integrity
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-15T17:14:57Z
parent: pkm-c1cg
---

## Problem

A 4xx response marks a durable batch poisoned, but its optimistic SQLite effects remain visible. SyncProvider does not observe poison events or trigger authoritative repair.

## Scope

Expose rejected-batch state and restore authoritative replica/UI state without reapplying the poisoned operation.

## Acceptance criteria

- [x] SyncProvider observes and surfaces poison events.
- [x] Poisoned optimistic effects are rolled back or removed by a guarded authoritative rebase.
- [x] Later feed/snapshot application does not reapply the poisoned batch.
- [x] The user receives a recoverable error state instead of silent divergence.
- [x] Provider-level and replica-level 4xx regression tests are added.
- [x] pnpm verify passes.

## Summary of Changes

Implemented typed durable poison events and deterministic 4xx ordering: mark, pause, emit, full-snapshot lease repair, poison deletion, resync, then later delivery. Startup discovers legacy and typed poisoned rows before normal sync. Failed repair remains a connected delivery problem with details and Retry; Dismiss is available only after successful repair. Poison repair preserves Task 1 persistence/delivery and stale-feed guards and reuses Task 2 deadline-bound, full-fingerprint, transactional recovery coordination without flushing later batches. Exact Task 3 suites passed 78/78, Task 2 compatibility passed 84/84, typecheck passed, and canonical pnpm verify passed 69 unit files / 713 tests, production/PWA build, and Playwright 6/6.
