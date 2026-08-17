---
# pkm-ij2s
title: Decompose SyncProvider orchestration and simplify repair UI
status: todo
type: task
priority: low
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:24Z
updated_at: 2026-08-17T20:55:24Z
parent: pkm-wvvu
---

## Review findings

Frontend `SyncProvider.tsx` and `OfflineIndicator.tsx` complexity findings.

The provider mount effect coordinates pending-state bootstrap, reconnect single-flight, drain observation, socket status, and StrictMode cleanup. Retry dispatch and the repair banner matrix are also harder to verify than their policies require.

## Acceptance criteria

- [ ] Separate mount-time pending/bootstrap, reconnect, drain-observer, and socket-status orchestration into named protocols or hooks
- [ ] Remove the TDZ-fragile `statusRef` declaration order and deduplicate replica restart dispatch
- [ ] Extract retry-problem dispatch from the memoized callback into a testable policy boundary
- [ ] Replace OfflineIndicator nested ternaries with per-kind rendering or an equivalently exhaustive readable mapping
- [ ] Preserve StrictMode cleanup, reconnect single-flight, status precedence, repair actions, alert roles, and copy/pluralization
- [ ] Add focused lifecycle and banner-state tests and update sync/frontend architecture
