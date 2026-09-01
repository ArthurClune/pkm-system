---
# pkm-gw5r
title: Offline pulls are misclassified as replica stalls → wrong 'Local sync is stuck' banner
status: todo
type: bug
priority: normal
created_at: 2026-09-01T21:26:51Z
updated_at: 2026-09-01T21:27:09Z
parent: pkm-fgjg
---

Found during the 2026-09-01 perf investigation; a UX bug rather than an energy sink.

## Symptom
Go offline for ~30 s with the app open. Banner shows *"Local sync is stuck: offline: /api/sync/changes?since=N is unavailable without a connection · Reset local data"*. Reproduced in the measurement run (scenario E: WS refused + HTTP degraded). The correct state is plain "Offline"; "stuck" with a Reset offer invites the user to wipe the replica for a network outage.

## Cause (confirmed from types, verified by the banner text at runtime)
While the socket is down `apiFetch` routes to the local shim, which does not serve `/api/sync/changes` and throws `OfflineError`. `OfflineError extends ApiError` (`web/src/api/client.ts:44-49`, status 0). `isStallShaped` (`web/src/sync/replicaSync.ts:142-145`) accepts any `ApiError`, so three offline pulls cross `STALL_AFTER_FAILURES` (`:64`) → `mode: "stalled"` → `SyncProvider.tsx:300-301` raises the banner unconditionally, not gated on connectivity. The header comment at `replicaSync.ts:130-141` says network-down failures are excluded; the code does not do that. The existing tests use `TypeError("offline")` (`replicaSync.test.ts:185, :209`), which *is* excluded — the real `OfflineError` shape is untested.

Side effect: the 60 s-capped retry keeps rescheduling while offline (~1 wakeup/min, minor), and nothing needs to un-stall on reconnect except the retry itself.

## Fix shape
Exclude `OfflineError` (or `status === 0`) from `isStallShaped`; don't reschedule the pull retry while `statusRef` is `"reconnecting"` (the reconnect flow restarts it). Add the missing test with a real `OfflineError`. Add a symptom row to `sync-and-offline.md`.

## Checklist
- [ ] Failing test: 3× OfflineError does not produce mode "stalled"
- [ ] Fix + banner check offline
- [ ] Symptom row in sync-and-offline.md
