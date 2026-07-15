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
updated_at: 2026-07-15T22:50:00Z
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

Added a pure per-outline causality core with revision-checked reads, deferred payloads, title-scoped write relevance, and in-flight lifecycle retention. Manual-token receipt now reports whether the parent still owns the current request, so overlapping same-title PageView and sidebar shells never publish an expired empty child. Existing-session bootstrap requires idle causal state and replaces blocks in place, preserving monotonic request ids, reservations, relevant writes, and deferred state. Every page-scoped ticket is retained at the Sync enqueue boundary, while cross-page DnD attaches target subtree/location metadata whenever the source node exists, independent of target mount state. A Shell-owned repair epoch dynamically enrolls every live session, requires an unchanged dispatch revision, adopts fresh server state, replays unresolved title-specific ticket actions in order, and synchronously releases legacy delivery. Legacy queue missed-kick handoff, offline and 5xx guards, Journal reservations, durable settlement, source-absent DnD behavior, replica FIFO/poison recovery, same-title editor sharing, Task 4 view-local state, and terminal delivery remain intact. Same-title parent shells now share accepted full PagePayload readiness and elect at most one surviving controller when the current winner fails or unmounts, so both panes render the same metadata and tree without stale loading, stale errors, or retry storms. Elected parent request identity now restores recovery eligibility only when a newer automatic or repair controller supersedes that live attempt; genuine elected failure or cancellation remains terminal at the one-recovery cap. Canonical pnpm verify passes (72 files / 814 unit tests and 6/6 Playwright tests).
