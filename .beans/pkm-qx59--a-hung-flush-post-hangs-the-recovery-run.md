---
# pkm-qx59
title: A hung flush POST hangs the recovery run
status: todo
type: bug
priority: low
created_at: 2026-11-11T12:49:54Z
updated_at: 2026-11-11T12:49:54Z
parent: pkm-4gda
---

The recovery flush posts through deliverLeased; mutations are never aborted. The lease frees the worker gate after RECOVERY_LEASE_MS, but runRecovery never settles and pullRun stays in flight, so every later nudge waits behind it. Finding B in docs/superpowers/plans/2026-11-11-w11-recovery-lease.md.
