---
# pkm-91ux
title: Failed lane (legacy) repair is never retried on reconnect
status: completed
type: bug
priority: normal
created_at: 2026-10-03T17:03:13Z
updated_at: 2026-10-04T14:36:46Z
parent: pkm-nws9
---

Found in the pkm-yxcs task and final reviews. A lane batch (in-memory fallback lane) that the server rejects pauses delivery and runs SyncProvider's repairLegacy (repairActiveOutlineSessions). If that repair fails because the device went offline, nothing retries it on reconnect, so later edits wait for the banner's Retry or a reload. Same 'a network blip strands edits' shape Arthur ruled must be fixed for poison repair (pkm-f170, now retried via reconnectFlow's retryFailedRepair). The sync property cannot see it: the harness stands in an unconditional resume for repairLegacy.

- [x] Unit reproduction (SyncProvider or a runtime-level test)
- [x] Retry a failed legacy repair on reconnect (likely via the same reconnect hook)
- [x] Decide whether the harness should model repairLegacy

## Summary of Changes

Legacy outline repair extracted from SyncProvider into sync/legacyRepair.ts (createLegacyRepair: run, retryFailed, rejected, clear), mirroring clientRuntime's poison repair retry. Every connect's first step now reruns the runtime's failed poison repair, then legacyRepair.retryFailed() (awaits an in-flight run, reruns a failed one once). Harness models it: the real module with a page read through the client's transport that fails offline; a new harness test shows a lane repair failed offline is retried on reconnect, and with the retry removed quiesce trips. Tests: 14 legacyRepair unit tests, a SyncProvider socket drop/reopen test; 6 mutations all caught. Gates: proptest web 38 passed, pnpm verify 3214 unit + 72 e2e, perf frontend no changes. Docs: frontend.md, sync-recovery.md, sync-and-offline.md, property-checks.md, troubleshooting row.
