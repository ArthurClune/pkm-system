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
updated_at: 2026-07-15T21:35:03Z
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

Added a pure per-outline causality core with revision-checked reads, deferred payloads, title-scoped write relevance, and in-flight lifecycle retention. Every page-scoped ticket is retained at the Sync enqueue boundary, while cross-page DnD attaches only the target subtree/location metadata that its wire move cannot reconstruct. A Shell-owned repair epoch invalidates older controllers, dynamically enrolls every live session, requires an unchanged dispatch revision, adopts fresh server state, and replays only still-unresolved title-specific ticket actions in order before synchronously releasing legacy delivery. Legacy queue drain ownership now retains an otherwise-eligible missed kick across asynchronous empty-repair resume, while offline, recovery, disposal, 5xx backoff, single-owner pumping, and replica behavior remain guarded. Released newcomers collect normally; live missing loaders and failed reads expose Retry without reapplying rejected or spanning operations. Journal reservations, durable settlement, replica FIFO/poison recovery, Task 4 editor/DnD/view-local state, and terminal delivery remain intact. Canonical pnpm verify passes (72 files / 801 unit tests and 6/6 Playwright tests).
