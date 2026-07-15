---
# pkm-z77x
title: Prevent outline refetches from overwriting or discarding newer state
status: todo
type: bug
priority: high
tags:
    - web
    - outline
    - concurrency
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-15T14:23:26Z
parent: pkm-c1cg
---

## Problem

useOutline can adopt a stale refetch after a newer local edit. It can also discard an incoming authoritative payload while any global operation is pending and never reconsider that payload after the queue drains.

## Scope

Introduce per-outline versioning/reconciliation and retain deferred authoritative payloads until relevant local work settles.

## Acceptance criteria

- [ ] A refetch response is adopted only if the outline has not changed since dispatch, or is safely rebased.
- [ ] The latest deferred authoritative payload is reconsidered after relevant writes drain.
- [ ] Pending work on unrelated pages does not indefinitely block this outline.
- [ ] Tests cover edits after fetch dispatch and pending-drain reconciliation.
- [ ] Own-echo filtering cannot leave the visible outline permanently stale.
- [ ] pnpm verify passes.
