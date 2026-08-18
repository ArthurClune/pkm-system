---
# pkm-ij2s
title: Decompose SyncProvider orchestration and simplify repair UI
status: completed
type: task
priority: low
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:24Z
updated_at: 2026-08-18T19:42:22Z
parent: pkm-wvvu
---

## Review findings

Frontend `SyncProvider.tsx` and `OfflineIndicator.tsx` complexity findings.

The provider mount effect coordinates pending-state bootstrap, reconnect single-flight, drain observation, socket status, and StrictMode cleanup. Retry dispatch and the repair banner matrix are also harder to verify than their policies require.

## Acceptance criteria

- [x] Separate mount-time pending/bootstrap, reconnect, drain-observer, and socket-status orchestration into named protocols or hooks
- [x] Remove the TDZ-fragile `statusRef` declaration order and deduplicate replica restart dispatch
- [x] Extract retry-problem dispatch from the memoized callback into a testable policy boundary
- [x] Replace OfflineIndicator nested ternaries with per-kind rendering or an equivalently exhaustive readable mapping
- [x] Preserve StrictMode cleanup, reconnect single-flight, status precedence, repair actions, alert roles, and copy/pluralization
- [x] Add focused lifecycle and banner-state tests and update sync/frontend architecture

## Summary of Changes

Refactor only — no behaviour change. The provider's one mount effect became two
named modules, the Retry dispatch became a pure policy, and the banner became
one component per problem kind.

**New modules**

| File | Pattern | Holds |
|---|---|---|
| `web/src/sync/reconnectFlow.ts` | Imperative Shell | The reconnect single-flight protocol: `begin()` (socket reconnect) and `observeDrain()` (the queue's drain observer) share one completion — drain → `replicaSync.start()` → `idle()` → resync bump |
| `web/src/sync/useSocketLifecycle.ts` | Imperative Shell | The connect lifecycle hook: mount-time pending bootstrap, drain-observer wiring, socket status, StrictMode-deferred teardown |
| `web/src/sync/retryPolicy.ts` | Functional Core | `planRetry(problem, { startupDiscoveringPoison })` → one of `legacy-repair` / `retry-poison-marks` / `continue-startup` / `repair-targets` / `none` |

**SyncProvider.tsx** — `statusRef`/`modeRef` moved to the top ref block (above
every closure that reads them), the mount effect replaced by
`useSocketLifecycle({...})`, `retryProblem` now a switch over `planRetry`, and
the two copies of `if (repairSucceededRef.current) await replicaSync?.start()`
deduplicated into one `restartAfterRepair` inside the memo. `everConnectedRef`
moved into the hook (its only reader).

**OfflineIndicator.tsx** — the five-deep nested ternary replaced by
`DeliveryProblemBanner`, which switches exhaustively over `problem.kind` into
`PoisonDiscoveryBanner`, `ReplicaUnavailableBanner`, `LegacyRejectedBanner`,
`RejectedBatchBanner`, `ReplicaStalledBanner`, plus `ConnectivityBanner`. Copy,
pluralization, `role` values and DOM structure are unchanged; the conditional
online-only safety sentence is now `onlineOnlySafetyCopy()`.

**Tests** — `reconnectFlow.test.ts` (7: ordering, blocked drain, out-of-band
drain completion, overlapping reconnects, post-unmount silence, no-replica
resync), `retryPolicy.test.ts` (14, table-driven over every problem state),
`OfflineIndicator.test.tsx` +16 (banner matrix pinning role + actions + copy
for all 13 kind/state combinations, banner ordering, legacy running/repaired),
`SyncProvider.test.tsx` +1 (StrictMode replay leaves exactly one live connect
lifecycle).

**Docs** — `frontend.md` module map gains the three modules;
`sync-and-offline.md` Key pieces row and the reconnect-ordering paragraph now
name `reconnectFlow.ts`, and "mount effect" corrected to "startup effect" where
it means the poison gate.

Verification: `cd web && CI=true pnpm verify` green (typecheck, lint, FCIS,
2218 unit tests with coverage thresholds met, build, 54 Playwright e2e).
