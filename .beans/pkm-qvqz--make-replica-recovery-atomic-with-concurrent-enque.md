---
# pkm-qvqz
title: Make replica recovery atomic with concurrent enqueues
status: completed
type: bug
priority: critical
tags:
    - web
    - sync
    - data-integrity
created_at: 2026-07-15T14:22:42Z
updated_at: 2026-07-15T16:36:59Z
parent: pkm-c1cg
---

## Problem

Replica recovery checks and flushes pending operations before reset, but enqueue RPCs can run concurrently between that check and the reset. An accepted edit can therefore be persisted and then erased.

## Scope

Coordinate replicaSync recovery, worker RPC dispatch, and enqueue persistence so recovery owns an exclusive reset window.

## Acceptance criteria

- [x] Enqueues are gated or serialized while recovery/reset is active.
- [x] Persistence is drained and pending work is rechecked immediately before reset.
- [x] No acknowledged enqueue can be erased by reset.
- [x] A deterministic enqueue-versus-reset concurrency regression test is added.
- [x] Existing schema-mismatch and rebootstrap behavior remains covered.
- [x] pnpm verify passes.

## Summary of Changes

Added a worker-owned FIFO recovery lease shared by every database-touching RPC, including Replica.enqueue and offline POST /api/pages. prepareRecovery waits for earlier work and captures/fingerprints the complete durable pending row set; commitRecovery compares those rows again inside the held gate immediately before reset-or-rebase plus snapshot, and invalid/double tokens reject. Later writes cannot acknowledge until commit/abort releases them into the fresh database.

Schema mismatch and feed needs-bootstrap now share this trace: pause queue -> prepare lease -> flush non-poisoned durable batches oldest-first -> fetch snapshot -> compare final durable rows -> reset-or-rebase plus snapshot -> release lease -> resume queue. Flush, snapshot, and commit failures report recovery-failed, defensively abort, retain pre-commit rows, and resume delivery. The acknowledgment guarantee begins at a successful worker enqueue/localApi RPC response: pre-barrier writes are flushed; post-barrier writes remain gated and persist after release.

Verification: focused compatibility suite 6 files / 76 tests; typecheck; git diff --check; canonical pnpm verify with 69 files / 700 unit tests, production build, and Playwright 6/6.

Review fix: schema reset now rebuilds DDL and applies the snapshot inside one SQLite transaction on the active OPFS connection, so any install/apply failure rolls back to the complete pre-commit database. Feed needs-bootstrap uses rebase, preserving pending and poisoned durable rows.
