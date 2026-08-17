---
# pkm-w5gf
title: Retire frontend legacy queue and test-only transport compatibility
status: todo
type: task
priority: high
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:22Z
updated_at: 2026-08-17T20:55:22Z
parent: pkm-wvvu
---

## Review findings

Frontend A1, B1, and the `opQueue.runDrain` complexity finding.

`createLegacyQueue` is a second queue selected only without a replica, primarily to support jsdom tests. Additional optional batch IDs, legacy payload shapes, and optional local API dependencies keep test-double compatibility in production paths.

## Acceptance criteria

- [ ] Point queue policy tests at a fake in-memory Replica and delete `createLegacyQueue` plus its duplicate dispatcher and `MAX_BATCH`
- [ ] Make Replica enqueue batch IDs required and remove unidentified-delivery FIFO bookkeeping
- [ ] Accept only the current object enqueue payload in worker handlers
- [ ] Make local API dependencies required, or provide an explicit production-safe `newBatchId` default that cannot silently degrade offline creation
- [ ] Extract named durable rejection and lane-head delivery protocols from `runDrain`; rename the side-effecting `laneOnly` predicate
- [ ] Preserve fallback-lane ordering, poison retention, recovery barriers, beforeunload protection, and offline edits with regression tests
- [ ] Reconcile this work with active bean `pkm-tu5k` before implementation to avoid conflicting queue changes
- [ ] Update sync/offline architecture documentation and run the full web verification gate
