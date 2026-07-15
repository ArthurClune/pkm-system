---
# pkm-z77x
title: Prevent outline refetches from overwriting or discarding newer state
status: completed
type: bug
priority: high
tags:
    - web
    - outline
    - concurrency
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-15T19:42:58Z
parent: pkm-c1cg
---

## Problem

useOutline can adopt a stale refetch after a newer local edit. It can also discard an incoming authoritative payload while any global operation is pending and never reconsider that payload after the queue drains.

## Scope

Introduce per-outline versioning/reconciliation and retain deferred authoritative payloads until relevant local work settles.

## Acceptance criteria

- [x] A refetch response is adopted only if the outline has not changed since dispatch, or is safely rebased.
- [x] The latest deferred authoritative payload is reconsidered after relevant writes drain.
- [x] Pending work on unrelated pages does not indefinitely block this outline.
- [x] Tests cover edits after fetch dispatch and pending-drain reconciliation.
- [x] Own-echo filtering cannot leave the visible outline permanently stale.
- [x] pnpm verify passes.

## Summary of Changes

Added a pure per-outline causality core and session-owned dispatch-time read tokens, revisions, deferred payloads, title-scoped write relevance, and in-flight lifecycle retention. Responses captured before delivery now trigger a guarded fresh read, while Journal pagination protects sessions created or changed during flight. Added per-ticket delivered completion while preserving settled as durable persistence, including exact FIFO legacy-ticket outcomes and dispose-during-enqueue failure. Added focused causality, hook, parent, queue, session, and DnD regressions; canonical pnpm verify passes (72 files / 768 unit tests and 6/6 Playwright tests).
