---
# pkm-dcmm
title: Own replica worker lifecycle and clarify queue idle semantics
status: todo
type: task
priority: high
tags:
    - web
    - sync
    - lifecycle
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-15T14:23:26Z
parent: pkm-c1cg
---

## Problem

Replica workers and RPC promises have no disposal/error lifecycle. Queue idle can resolve while retryable or offline batches remain unsent, despite a drained-queue contract.

## Scope

Add explicit replica disposal and failure propagation, and distinguish settled persistence from fully drained delivery.

## Acceptance criteria

- [ ] Replica exposes dispose or close behavior and SyncProvider terminates owned workers on cleanup.
- [ ] Pending RPC calls reject on worker error, message error, timeout where appropriate, or disposal.
- [ ] No provider remount leaks worker or OPFS resources.
- [ ] Queue APIs distinguish settled from drained/blocked states.
- [ ] Reconnect flows use the correct queue semantic and retry policy.
- [ ] Worker-failure, cleanup, offline, and transient-5xx tests are added.
- [ ] pnpm verify passes.
