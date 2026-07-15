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
updated_at: 2026-07-15T17:37:39Z
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

## Independent Review Fix

Added shared poison recovery ownership before waiting on an in-flight feed. A concurrent feed that returns needs-bootstrap now defers normal Task 2 recovery while poison repair is pending, so later non-poisoned rows cannot flush and the queue boolean pause cannot resume early. Ownership survives failed repair and Retry; SyncProvider releases it only after poison deletion and resync scheduling, immediately before provider-owned resume. Fresh verification passed: focused 62/62, exact Step 5 78/78, Task 2 compatibility 85/85, typecheck, canonical 69 files / 714 unit tests, build, and Playwright 6/6.

## Second Review Race Fix

Established synchronous poison-pending ownership before the durable mark, preempted and aborted stale normal recovery leases before every flush POST, suppressed their normal failure/resume path, and retained the barrier when marking fails. Public poison details still follow durable marking; no-poison Task 2 recovery is unchanged. Fresh verification passed: focused 64/64, exact Step 5 79/79, Task 2 compatibility 87/87, typecheck, canonical 69 files / 716 unit tests, build, and Playwright 6/6.
