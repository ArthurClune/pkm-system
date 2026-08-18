---
# pkm-nqve
title: Share replica recovery lifecycles and tighten reset contracts
status: completed
type: task
priority: normal
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:23Z
updated_at: 2026-08-18T16:35:58Z
parent: pkm-wvvu
---

## Review findings

Frontend A5 recovery half. `resetLocalData` reimplements `runRecovery` prepare, flush, snapshot, commit, and resume lease handling with small deltas, so lifecycle fixes can drift.

## Acceptance criteria

- [x] Extract a shared recovery-lease protocol or extend `runRecovery` with explicit reset options
- [x] Represent `ResetBlockedError`, started-state, and forced-ready differences as named options or results rather than duplicated control flow
- [x] Guarantee resume/finalization on every success, failure, and cancellation path
- [x] Preserve pending operations and availability state according to current recovery policy
- [x] Add deterministic tests for reset, recovery, blocked reset, snapshot failure, commit failure, and cleanup ordering
- [x] Update sync-and-offline architecture documentation


## Summary of Changes

`runRecovery` in `web/src/sync/replicaSync.ts` is now the only recovery-lease
lifecycle. `resetLocalData` kept the poison-ownership entry guard and the
online-only note, and delegates everything else; its copy of the
pause/lease/flush/snapshot/commit/release sequence is gone.

The deltas are named `RecoveryOptions` fields rather than duplicated control
flow:

- `flush`: `"skip"` | `"preemptible"` | `"blocking"`. Blocking is reset with
  `discardPending: false`, where a failed flush raises `ResetBlockedError` and
  keeps the database intact.
- `forceReadyOnSuccess`: reset alone sets `started` and force-reports `ready`.
- `reportReplicaFailure`: unchanged in meaning; reset passes false because
  SyncProvider raises its own reset-failed banner.
- `awaitInFlightPull`: reset and poison repair wait for a pull that already
  passed the pending-id guard; in-pull recovery must not, or it awaits itself.

Resume and lease abort stay in the shared `catch`/`finally`, so success,
failure and poison-preemption paths all finalize identically. Poison repair no
longer pauses the queue twice (the shared run pauses ahead of the same wait it
used to perform itself); `pause` sets a boolean in `queueState`, so the second
call was already a no-op.

Ten new tests in `web/src/sync/replicaSync.test.ts` (49 total in the file), all
written and confirmed green against the pre-refactor code: reset trace with the
poisoned row skipped, reset waiting on a guarded pull, reset snapshot failure,
reset commit-failure cleanup ordering, a blocked reset handing delivery back,
and a table-driven barrier test over every entrant that owns resumption on both
the success and failure paths. Deliberately breaking the protocol (resume moved
out of `finally`) fails 7 tests; dropping the poison exception fails 4.

Docs: `docs/architecture/sync-and-offline.md` § Rebootstrap triggers now names
the two on-request rebootstraps and tables the per-entrant options.

Verification: `pnpm typecheck`, `pnpm lint`, `pnpm check:fcis`,
`pnpm test:coverage` (129 files, 2098 tests, thresholds met), `vite build`, and
Playwright on port 8982 (53 passed).
