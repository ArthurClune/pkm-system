---
# pkm-s7af
title: Retain ops on any replica-unavailable error instead of matching messages
status: todo
type: task
created_at: 2026-08-04T12:54:38Z
updated_at: 2026-08-04T12:54:38Z
parent: pkm-q2jj
---

opQueue retains on TYPE, for both `unusable` and `unreachable`. Deletes the isSahPoolContention/isPoolExhausted message matching on that path. Closes pkm-9x6u including the RpcLifecycleError half that an availability mode alone would miss. The two-level distinction matters here: both levels retain, but only `unusable` may lift the barrier.

Part of epic pkm-q2jj. Design: docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md
