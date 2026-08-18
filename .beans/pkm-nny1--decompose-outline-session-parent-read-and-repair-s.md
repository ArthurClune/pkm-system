---
# pkm-nny1
title: Decompose outline session parent-read and repair state machines
status: completed
type: task
priority: low
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:24Z
updated_at: 2026-08-18T19:45:53Z
parent: pkm-wvvu
---

## Review findings

Frontend `outline/outlineSessions.ts` complexity finding. Registry/refcount/lease ownership, parent-read election, and repair epochs are independently coherent machines currently colocated in an 882-line module.

## Acceptance criteria

- [x] Extract parent-read election behind a focused interface with isolated tests
- [x] Extract repair-epoch state and transitions behind a focused interface with isolated tests
- [x] Leave registry/refcount/lease ownership readable in the remaining session module
- [x] Preserve ReadToken supersession, manual-read abandonment, parent waiter publication, reservation semantics, and repair ordering
- [x] Avoid changing public session behavior solely to make extraction easier
- [x] Update frontend and sync architecture documentation and run focused race suites plus full web verification

## Summary of Changes

Two machines moved out of `web/src/outline/outlineSessions.ts` (939 -> 780
lines); no public session behaviour changed.

**`web/src/outline/parentReadElection.ts`** (Shell, new) — one session's
parent-read election. Created per session by `createParentReadElection(host)`
and queried through `ParentReadHost` (`latestRequestId`, `hasActivatedCapture`,
`manualReadCount`, `hasManualRead`, `repairActive`, `publishedBlocks`), so it
owns no session state and writes none. `ParentReadElection` is
`publish`/`awaitPayload`/`hasAcceptedFor`/`addController`/`releaseWaiters`/
`schedule`/`noteReadBeginning`/`noteReadAbandoned`/`expireRecoveryBefore`.
`ParentReadiness` moved here and is re-exported from `outlineSessions.ts`, so
`useOutlinePageLoad.ts` is untouched.

**`web/src/outline/repairEpochs.ts`** (Shell, new) — the global repair epoch,
now stated over `RepairTarget` (`currentState`/`isActive`/`repairRead`/
`settle`) and `RepairCohort` (`targets`/`epochEnded`) instead of over the
session registry. Exports `runRepair`, `isRepairActive`,
`activeRepairCompletion`. `repairActiveOutlineSessions` keeps its signature and
delegates. The unused `RepairEpoch.id` counter went with it.

Invariants preserved by construction: `startAuthoritativeRead` and the
`receiveAuthoritative*` token/revision guards never moved; `repairRead`'s
synchronous prelude (supersede tokens, capture the previous transport) still
runs before its promise exists, so repair ordering is unchanged;
`abandonManualRead` still computes "was this the newest read" before
`finishManualRead` and hands the verdict to the election; reservations
(`manualReads`, `activatedCaptures`, `reservations`) stayed with the registry.

Tests: `parentReadElection.test.ts` (16) and `repairEpochs.test.ts` (7), both
driven by fakes with no session registry. Every pre-existing race suite passes
unmodified — `outlineSessions.test.ts` (31), `PageView.test.tsx` (24),
`Journal.test.tsx` (15), `EditableSidebarPanel.test.tsx` (14). `pnpm verify`
green: 2203 unit tests, coverage above thresholds (new modules 100% lines), 54
Playwright specs.

Docs: `frontend.md` module map plus a State-management paragraph naming both
machines and their interfaces; `sync-and-offline.md` now says what the
`onDesync` repair is, that it is a fixed point, and why delivery resumes only
from `onStable`.
