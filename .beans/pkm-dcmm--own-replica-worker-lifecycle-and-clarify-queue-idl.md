---
# pkm-dcmm
title: Own replica worker lifecycle and clarify queue idle semantics
status: completed
type: task
priority: high
tags:
    - web
    - sync
    - lifecycle
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-15T16:12:26Z
parent: pkm-c1cg
---

## Problem

Replica workers and RPC promises have no disposal/error lifecycle. Queue idle can resolve while retryable or offline batches remain unsent, despite a drained-queue contract.

## Scope

Add explicit replica disposal and failure propagation, and distinguish settled persistence from fully drained delivery.

## Acceptance criteria

- [x] Replica exposes dispose or close behavior and SyncProvider terminates owned workers on cleanup.
- [x] Pending RPC calls reject on worker error, message error, timeout where appropriate, or disposal.
- [x] No provider remount leaks worker or OPFS resources.
- [x] Queue APIs distinguish settled from drained/blocked states.
- [x] Reconnect flows use the correct queue semantic and retry policy.
- [x] Worker-failure, cleanup, offline, and transient-5xx tests are added.
- [x] pnpm verify passes.

## Summary of Changes

- Added terminal RPC lifecycle handling: worker errors, message decode errors,
  disposal, and per-call timeouts reject and remove pending entries; late replies
  are ignored. Ordinary calls time out after 30 seconds, while snapshot/reset
  calls use 120 seconds.
- Added idempotent `Replica.dispose()`. The worker closes its active SQLite/OPFS
  database before the main thread terminates the internally owned Worker.
  SyncProvider never disposes a caller-injected replica, and StrictMode effect
  replay does not prematurely dispose memoized worker resources.
- Replaced ambiguous write completion with `WriteTicket`: settlement reports
  `{status: "persisted", pending}` after replica durability or legacy in-memory
  retention, and `{status: "failed", error}` for storage failure. HTTP delivery
  cannot retroactively change ticket settlement.
- Added typed drain outcomes for drained, offline, retryable, recovering, and
  disposed states. Retryable delivery retains queued work and uses cancellable
  250 ms, 1 second, then capped 5 second retries; reconnect and success reset
  the schedule, while offline/dispose cancels it.
- Reconnect now advances to replica feed pull and view resync only after a
  drained outcome, including when an automatic retry later reaches drained; the
  continuation is single-flight so feed pull and resync happen exactly once.
  Overlapping reconnect intents are consumed before reusing an active
  completion, so a later unrelated drain cannot trigger stale reconnect work.
  Outline-facing code waits for ticket/persistence settlement, not the provider-
  internal global delivery drain.
- Replica `nextBatch`, `deleteBatch`, and `markPoisoned` failures fulfill drain
  with typed blocked outcomes. Automatic drain outcomes are observed without
  unhandled rejections, and terminal lifecycle state is classified when the
  failure returns.
- Added focused coverage for terminal RPC events, timeout/disposal, close-before-
  terminate ownership, StrictMode replay, offline persistence, typed drain
  blocking, the complete 250 ms/1 second/5 second retry schedule and resets,
  transient 503 retry continuation, retry cancellation, and zero durable pending.

- Changes-feed application now carries the pending batch IDs observed at
  request dispatch into the worker. If enqueue/ack deletion changed that
  durable set before application, the stale response is discarded without
  mutating rows or cursor and refetched from the same cursor, preventing an
  acknowledged optimistic edit from disappearing during offline reload.

- Corrected the RPC runtime module's FCIS declaration to Imperative Shell,
  reflecting its MessagePort event registration, mutable pending/timer
  lifecycle, message I/O, and disposal responsibilities.
