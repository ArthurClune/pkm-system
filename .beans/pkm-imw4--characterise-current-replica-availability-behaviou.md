---
# pkm-imw4
title: Characterise current replica-availability behaviour before refactoring
status: todo
type: task
priority: normal
created_at: 2026-08-04T12:54:38Z
updated_at: 2026-08-04T12:54:50Z
parent: pkm-q2jj
blocking:
    - pkm-za9j
---

Write tests that pass on TODAY's code for every behaviour the refactor must preserve: the pkm-bjae latch, opQueue's retain-vs-desync split, the barrier lift, the exit-1 gate, the replica-unavailable banner, and the no-replica mode transition. This is the regression net for a change that removes three load-bearing things from the path behind pkm-c9hp, pkm-ndcu, pkm-hhbc, pkm-wi25 and pkm-bjae. Any behaviour that CANNOT be pinned against today's code is a behaviour nobody has verified -- record it as a finding rather than quietly preserving it.

Part of epic pkm-q2jj. Design: docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md
