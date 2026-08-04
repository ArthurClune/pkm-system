---
# pkm-y35i
title: Carry replica unavailability as a typed error, not a message match
status: todo
type: task
priority: normal
created_at: 2026-08-04T12:54:38Z
updated_at: 2026-08-04T12:54:50Z
parent: pkm-q2jj
blocking:
    - pkm-s7af
---

Add ReplicaUnavailableError (extends ReplicaError, so existing instanceof checks keep working) and an `unavailable` boolean on the wire error shape beside `quota`, following the precedent documented at rpc.ts:4. No consumers in this step. Note: only `unusable` crosses the wire (the worker reporting its own failed open); `unreachable` is generated client-side by the RPC layer, so the two levels are combined on the main thread, never in the wire shape. Also ensure isStallShaped does NOT count an unavailable error, or a session reports stalled on top of no-replica and computeEditability can flip it read-only.

Part of epic pkm-q2jj. Design: docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md
