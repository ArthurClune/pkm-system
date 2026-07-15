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
updated_at: 2026-07-15T20:27:54Z
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

Added a pure per-outline causality core and session-owned dispatch-time read tokens, revisions, deferred payloads, title-scoped write relevance, and in-flight lifecycle retention. Responses captured before delivery trigger guarded fresh reads, while Journal pagination protects sessions created or changed during flight. Independent-review fixes retain unresolved cross-page tickets for sessions opened after dispatch, reserve and explicitly cancel manual read tokens, and make legacy 4xx delivery ticket-aware: rejected and spanning tickets are terminal, wholly later tickets remain pending behind an authoritative-repair barrier, and failed repair exposes Retry without reapplying rejected ops. Durable settlement, replica poison recovery, offline and 5xx retry, dispose, single-flight reads, and view-local editor state remain intact. Canonical pnpm verify passes (72 files / 778 unit tests and 6/6 Playwright tests).
