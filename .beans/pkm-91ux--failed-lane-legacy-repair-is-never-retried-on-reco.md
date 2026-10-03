---
# pkm-91ux
title: Failed lane (legacy) repair is never retried on reconnect
status: todo
type: bug
created_at: 2026-10-03T17:03:13Z
updated_at: 2026-10-03T17:03:13Z
parent: pkm-nws9
---

Found in the pkm-yxcs task and final reviews. A lane batch (in-memory fallback lane) that the server rejects pauses delivery and runs SyncProvider's repairLegacy (repairActiveOutlineSessions). If that repair fails because the device went offline, nothing retries it on reconnect, so later edits wait for the banner's Retry or a reload. Same 'a network blip strands edits' shape Arthur ruled must be fixed for poison repair (pkm-f170, now retried via reconnectFlow's retryFailedRepair). The sync property cannot see it: the harness stands in an unconditional resume for repairLegacy.

- [ ] Unit reproduction (SyncProvider or a runtime-level test)
- [ ] Retry a failed legacy repair on reconnect (likely via the same reconnect hook)
- [ ] Decide whether the harness should model repairLegacy
