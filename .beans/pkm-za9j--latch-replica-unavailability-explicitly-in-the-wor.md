---
# pkm-za9j
title: Latch replica unavailability explicitly in the worker
status: todo
type: task
created_at: 2026-08-04T12:54:38Z
updated_at: 2026-08-04T12:54:38Z
parent: pkm-q2jj
---

buildHandlers latches `unavailable: ReplicaUnavailableError | null` on the first openDb() failure; every handler rejects with it; close() stays the only reset. This REPLACES pkm-bjae's latch, which worked by leaving the memoised dbPromise rejection in place -- correct but implicit, its safety depending on a reader noticing that init() must not clear a promise three modules from where the consequence lands.

Part of epic pkm-q2jj. Design: docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md
