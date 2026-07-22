---
# pkm-80ds
title: 'Surface wedged replica sync: stall detection, backoff, banner + reset action'
status: completed
type: bug
priority: high
created_at: 2026-07-22T10:12:47Z
updated_at: 2026-07-22T13:20:00Z
---

Fix A of docs/superpowers/specs/2026-07-22-sync-hardening-design.md (incident bean pkm-8uld). pullLoop swallows all errors -> cursor freezes forever invisibly (Mac stuck at seq 3911). Add stall detection (3 consecutive failed/no-progress pulls; pending-changed cap 20/loop), backoff retries (1s..60s), new ReplicaState 'stalled', SyncProblem 'replica-stalled' banner with Reset local data action reusing runRecovery('reset', {flush:true}) with failed-flush confirm.

## Summary of Changes

Implemented across four tasks (6-9), closing out Fix A end to end:

- **Task 6** (`web/src/sync/replicaSync.ts`): `pullLoop` no longer swallows errors silently. It now detects a stall after 3 consecutive failed/no-progress pulls (and caps pending-changed churn at 20 iterations/loop to avoid starving on a continuously-mutating pending set), retries with exponential backoff (1s..60s, stoppable timer), and adds a new `ReplicaState` mode `"stalled"`. `resetLocalData({ discardPending })` reports readiness correctly and respects the poison barrier; it throws `ResetBlockedError` (carrying the pending count) when unsent local changes would be silently discarded.
- **Task 7** (`web/src/sync/syncState.ts`): modeled the `replica-stalled` problem lifecycle as a pure state machine — `SyncProblem` grew a `"replica-stalled"` variant (`error`, `reset: "idle" | "running" | "blocked" | "failed"`, optional `pending`/`resetError`), and `transitionSync` grew matching events (`replica-stalled`, `replica-unstalled`, `reset-started`, `reset-blocked`, `reset-failed`, `reset-succeeded`). A stalled report never clobbers a different-kind delivery problem already in flight (rejected-batch/legacy-rejected take precedence), and a re-report onto an in-flight reset preserves the reset phase rather than resetting it to idle.
  - `ReplicaMode` (Task 7) is derived from `ReplicaState["mode"]` (Task 6) and consumed by `computeEditability`, which now explains a stalled replica offline ("local data is stale — reset local data to recover") while still allowing connected editing (server-authoritative).
- **Task 8** (`web/src/sync/SyncProvider.tsx`): wired the above into the live provider. `useSync()` exposes `resetReplica(discardPending?: boolean): Promise<void>`, which dispatches `reset-started`, awaits `replicaSync.resetLocalData`, and dispatches `reset-succeeded`/`reset-blocked`/`reset-failed` depending on the outcome (catching `ResetBlockedError` specifically for the blocked case).
- **Task 9** (`web/src/components/OfflineIndicator.tsx`, `web/src/sync/syncState.ts`, `web/src/sync/SyncProvider.tsx`): added the `replica-stalled` banner — a `role="alert"` `.ws-banner` reporting "Local sync is stuck: {error}" with a "Reset local data" button (disabled while `reset === "running"`, calls `resetReplica(false)`), an additional "Reset failed: {resetError}." line when `reset === "failed"`, and a distinct blocked-state message ("N unsent change(s) could not be delivered.") with "Discard and reset" (`resetReplica(true)`) and "Keep waiting" (`dismissProblem`) actions. Extended `syncState`'s `"dismiss"` transition so it also clears a `replica-stalled` problem when `reset` is `"blocked"` or `"failed"` (user has acknowledged the outcome) — an idle or running stall is never dismissable, since the plain stalled banner is the only signal a user has that local data is broken; they resolve it via reset, not dismissal. Wired `SyncProvider`'s `dismissProblem` to recognize the acknowledged-reset case and dispatch `"dismiss"` (previously a no-op for this problem kind). A later stall re-report onto a cleared problem creates a fresh idle one, so re-raising works naturally without special-casing.

### Test evidence
- `cd server && uv run pytest -q` — 603 passed, 95.26% coverage (>= 95% gate).
- `cd server && uv run pyrefly check` — 0 errors.
- `cd server && uv run ruff check` — all checks passed.
- `cd web && pnpm vitest run src/components/OfflineIndicator.test.tsx src/sync/syncState.test.ts src/sync/SyncProvider.test.tsx` — 105 passed (19 in OfflineIndicator, 43 in syncState, 43 in SyncProvider), including 8 new tests written first (failing) for the Task 9 banner and 4 new tests for the syncState dismiss-on-replica-stalled behavior.
- `cd web && pnpm build && pnpm verify` — typecheck, lint, `check:fcis` (112 modules, no boundary violations), unit tests with coverage (95 files, exit 0), production build, and all 18 Playwright E2E specs green (exit 0 end to end).

### Bundle budget rebaseline
`pnpm build` initially failed the `initialEntryBytes` budget (464755 actual vs. 462016 limit, +2739). Isolated the cause by building the pre-Task-9 commit (0fba1b1, end of Task 8) in a separate worktree: it already measured 463919 (+1903 over), so most of the growth is from Tasks 6-8's eagerly-loaded stall-detection/backoff/resetLocalData plumbing and syncState lifecycle, not Task 9's banner JSX (~836 bytes on top). No earlier task in this branch had run the full `pnpm build` gate — per the plan, that check was deliberately deferred to this final task. Rebaselined `web/tooling/budgets.json`'s `initialEntryBytes` to 487063 (actual + ~4.8% headroom, matching this budget's established methodology) with a documented rationale entry; all other budgets were unaffected and left unchanged.

### Deviations from the brief
None beyond the budget rebaseline above, which was necessary to get a clean `pnpm build`/`pnpm verify` and is exactly the documented process this repo already uses for eager-entry growth (see the other rationale entries in `budgets.json`).

### Self-review
Confirmed the `dismissProblem` no-op gap called out in the Task 9 handoff notes was real (traced through `SyncProvider.tsx`) before fixing it in both `syncState.ts`'s `"dismiss"` case and `SyncProvider.tsx`'s `dismissProblem`, with tests asserting the idle/running cases are *not* dismissable (the only signal of a broken replica) as well as the blocked/failed cases that are.
