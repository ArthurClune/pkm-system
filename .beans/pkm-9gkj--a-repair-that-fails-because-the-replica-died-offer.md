---
# pkm-9gkj
title: A repair that fails because the replica died offers only a Retry that cannot work
status: completed
type: bug
priority: normal
created_at: 2026-11-11T07:17:46Z
updated_at: 2026-11-11T14:35:11Z
parent: pkm-4gda
---

When the replica worker dies during a rejected-batch repair, or during startup's check for rejected rows, the banner stays on 'Local repair failed' (or the discovery-failed problem) with Retry. Retry cannot succeed with a dead worker; Reload would. The rejected-batch problem outranks the online-only banner in the sync state's fold, so Reload never shows. SyncState.replicaGone now records that the replica is gone, so the fold can offer Reload in that case. Needs a decision on the banner copy and ranking, a syncState test per case, and a look at the offline indicator.

## Decision (Arthur, 2026-11-11)

Reload outranks: when the replica is gone, the banner offers Reload ahead of the rejected-batch problem's Retry.

## Checklist

- [x] Trace which problems' action needs the replica worker
- [x] syncState tests per event order (red first), session tests for a dead worker in repair and in discovery
- [x] Fold change in transitionSync (needsWorker)
- [x] Mutation-check the ranking condition
- [x] Offline indicator checked against the new ranking
- [x] sync-recovery.md § What the UI shows
- [x] Web gates and the sync property suite

## Summary of Changes

Symptom: after the replica worker died, the banner stayed on "Server rejected a change (HTTP …): …. Local repair failed: …" (or "Checking rejected changes failed: …") with a Retry that never works.

Cause: transitionSync's ranking let every delivery problem outrank the online-only `replica-unusable` banner, but a rejected batch's repair and startup's poison discovery both run on the worker, which the RPC client latches as dead for the session.

Fix: with `SyncState.replicaGone` set, a problem that needs the worker (`needsWorker`: a rejected batch whose repair is running or failed, a failed poison discovery) is replaced by the outline problem held in `outlineBehind`, else by `replica-unusable` with its Reload. A failed mark keeps its banner (its Discard needs no worker, and a replica that never opens fails the same mark after a reload), as do outline problems and a repaired batch. The rule is in docs/architecture/sync-recovery.md § What the UI shows.

Paused copy: while the queue's barrier has a `poison` or `startup` holder (`heldForPoison`, read through `OpQueue.onBarrier` into `SyncState.deliveryHeld`), the `replica-unusable` problem carries `paused` and the banner says "Changes are paused until you reload." in place of "Your changes are still being saved to the server.", followed by the memory-only sentence whenever changes are unsent, connected or not. Stated in docs/architecture/sync-recovery.md § What the UI shows.
