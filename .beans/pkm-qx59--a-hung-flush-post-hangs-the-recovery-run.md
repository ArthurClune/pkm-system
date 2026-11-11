---
# pkm-qx59
title: A hung flush POST hangs the recovery run
status: scrapped
type: bug
priority: low
created_at: 2026-11-11T12:49:54Z
updated_at: 2026-11-11T13:19:30Z
parent: pkm-4gda
---

The recovery flush posts through deliverLeased; mutations are never aborted. The lease frees the worker gate after RECOVERY_LEASE_MS, but runRecovery never settles and pullRun stays in flight, so every later nudge waits behind it. Finding B in docs/superpowers/plans/2026-11-11-w11-recovery-lease.md.


## Reasons for Scrapping

Deliberate, not a W11 gap: api/client.ts never times out a non-GET request, because retrying a batch it cannot know landed is judged worse than a slow one, and the ordinary queue drain has the same exposure. The OS's TCP timeout bounds it, and it has never been observed. (Arthur, 2026-11-11.)
