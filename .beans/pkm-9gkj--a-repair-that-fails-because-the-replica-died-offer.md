---
# pkm-9gkj
title: A repair that fails because the replica died offers only a Retry that cannot work
status: todo
type: bug
priority: normal
created_at: 2026-11-11T07:17:46Z
updated_at: 2026-11-11T10:38:32Z
parent: pkm-4gda
---

When the replica worker dies during a rejected-batch repair, or during startup's check for rejected rows, the banner stays on 'Local repair failed' (or the discovery-failed problem) with Retry. Retry cannot succeed with a dead worker; Reload would. The rejected-batch problem outranks the online-only banner in the sync state's fold, so Reload never shows. SyncState.replicaGone now records that the replica is gone, so the fold can offer Reload in that case. Needs a decision on the banner copy and ranking, a syncState test per case, and a look at the offline indicator.

## Decision (Arthur, 2026-11-11)

Reload outranks: when the replica is gone, the banner offers Reload ahead of the rejected-batch problem's Retry.
