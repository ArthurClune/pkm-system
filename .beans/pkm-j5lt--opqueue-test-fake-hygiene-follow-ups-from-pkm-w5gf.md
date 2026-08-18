---
# pkm-j5lt
title: opQueue orphan delivery, memReplica parity, and test helper hygiene
status: completed
type: task
priority: low
created_at: 2026-08-18T13:55:14Z
updated_at: 2026-08-18T20:37:46Z
---

## Goal

Finish all four opQueue test-fake hygiene findings in one bounded change: pin orphan durable-ticket settlement, restore memReplica parity with the real SQLite queue, consolidate lane-only fixtures, and rebuild gatedFetch from the shared test helpers.

## Acceptance criteria

- [x] Add an orphan-ticket regression in web/src/sync/opQueue.replica.test.ts: enqueue two durable tickets while offline, model a SUCCESSFUL out-of-band recovery/reset flush by removing one row from replica.rows, drain the remaining row, and assert both tickets resolve { status: "delivered" }. The remaining row's delete must take the pendingCount === 0 finishAllDeliveries path and the next loop must take the batch === null path.
- [x] Make web/src/sync/memReplica.ts match web/src/replica/queue.ts when deleteBatch receives a missing id: leave every row intact and return the unchanged non-poisoned pending count. Pin this with a direct fake test.
- [x] Consolidate the repeated SQLITE_CANTOPEN lane-forcing Replica setups behind laneOnlyReplica, including variants that need additional Replica overrides; rebuild gatedFetch from the existing deferred and fetchSeq helpers instead of maintaining its own promises, fetch counter, and body recorder.
- [x] Make memReplica.enqueue match queue.ts for an empty ops array: record neither a row nor an enqueued id, preserve pending count, and still return the caller-supplied batchId. Pin this with a direct fake test.
- [x] Run targeted red/green tests and the full web verification gate; update this checklist and add a Summary of Changes before completing the bean.

## Corrected scope note

The old wording called the orphan case a "recovery flush/rebase shape." That is too broad after the recovery lifecycle refactor. A normal `commitRecovery("rebase")` applies a snapshot while preserving durable pending rows; a successful schema/manual reset flush can rebuild the database and remove rows outside opQueue. The regression should therefore describe a successfully POSTed out-of-band recovery/reset flush. It must not imply that a discard-pending reset received a server acknowledgement.

## Handover note (context-reset safe, 2026-08-18)

User approved implementing all four findings in one go. Resume in:

- Worktree: /Users/arthur/code/llm/pkm/.worktrees/pkm-j5lt
- Branch: worktree-pkm-j5lt
- Bean: pkm-j5lt (this file is the only intended tracked change so far)
- Baseline: `cd web && pnpm exec vitest run src/sync/opQueue.replica.test.ts` passed 64/64 before implementation.
- Dependencies: `pnpm install --frozen-lockfile` already completed in the worktree.
- Main checkout was clean before worktree creation.

Relevant current code:

- `web/src/sync/opQueue.ts`: `finishAllDeliveries({ status: "delivered" })` is called when `nextBatch()` returns null and again after a delete reports `pendingCount === 0`. Ordinary drains exercise these calls only with an empty deliveries map; no current test retains the ticket for a row removed out of band.
- `web/src/sync/opQueue.replica.test.ts`: existing row-flush tests at the "poisoned durable batch..." and "rebase-flushed durable queue..." cases discard the durable ticket handles and assert fallback tickets only. The file already defines `deferred`, `fetchSeq`, a late `laneOnlyReplica`, and a hand-rolled `gatedFetch`.
- `web/src/sync/memReplica.ts`: missing-id delete currently does `rows.splice(-1, 1)`; empty enqueue always appends to `enqueued` and `rows`.
- `web/src/replica/queue.ts`: SQLite DELETE on a missing id is a no-op; `enqueueBatch` inserts only when `ops.length > 0`.

Required workflow:

1. Run `beans prime`; read CLAUDE.md and the superpowers TDD instructions. This is approved as a bounded design—do not re-run brainstorming unless scope changes.
2. TDD orphan settlement first: add the focused test to `opQueue.replica.test.ts`. To prove the regression is meaningful, temporarily remove/disable both delivered `finishAllDeliveries` calls or otherwise run the test against a mutation and observe the orphan promise fail to settle; restore production code before continuing. Avoid an indefinitely awaiting assertion—use a settlement flag/microtask or a raced sentinel so RED terminates.
3. TDD fake parity in a focused `web/src/sync/memReplica.test.ts`: first add the missing-delete and empty-enqueue tests and observe their current failures; then add the minimal guards in memReplica.
4. With behavior green, refactor test helpers: move/generalize `laneOnlyReplica(over: Partial<Replica> = {})` near CANTOPEN and replace all equivalent inline lane-only fakes. Implement `gatedFetch` by composing `deferred<void>()` and `fetchSeq`; update gated assertions to use fetchSeq's `{ url, body }` records. Do not change queue behavior.
5. Run `cd web && pnpm exec vitest run src/sync/memReplica.test.ts src/sync/opQueue.replica.test.ts`, then `cd web && pnpm verify`.
6. Check whether architecture docs changed. Expected answer: no—the work is confined to tests/test-fake fidelity and does not alter shipped system shape.
7. Check every acceptance item, append `## Summary of Changes`, set pkm-j5lt completed only when no unchecked items remain, commit bean plus code on worktree-pkm-j5lt, then use the repository's branch-finishing workflow. Repository merge policy is `git merge --no-ff`.

Important cautions:

- Preserve the distinction between a successful out-of-band flush (delivery outcome may be "delivered") and an explicit discard-pending reset.
- memReplica is test-only but now drives the queue policy suite, so semantic parity matters.
- Do not edit architecture docs unless implementation unexpectedly changes production behavior.

## Summary of Changes

- Added a mutation-proven regression for delivery tickets orphaned by a successful out-of-band durable-row flush.
- Matched memReplica to SQLite queue semantics for missing-id deletes and empty-op enqueues, with focused direct tests.
- Consolidated SQLITE_CANTOPEN lane fixtures and rebuilt gatedFetch from the shared deferred/fetchSeq helpers.
- Verified the two focused suites (67 tests) and the full web gate, including typecheck, lint, FCIS, coverage, production build budgets, and 54 Playwright tests.
- Confirmed no architecture documentation update is needed because shipped system behavior and shape are unchanged.
