---
# pkm-jyx1
title: 'A 401 (or 403/408/429) on a batch is treated as rejection: poisoned or dropped, then deleted by the repair after login'
status: completed
type: bug
priority: high
created_at: 2026-09-29T13:20:31Z
updated_at: 2026-09-29T14:18:00Z
parent: pkm-a4t2
---

Review F4 (P1, pre-existing). Both delivery sites in `opQueue.ts` use
`ApiError && 400 <= status < 500` as the terminal predicate: a range, not a
list, so 401, 403, 408, 409, 413, 422 and 429 are all "rejected". On a 401
`apiFetch` navigates to `/login` and throws. The lane settles the head as
failed and the only copy is gone. The durable path writes a poison intent to
localStorage and marks the row; the repair's snapshot fetch also 401s, so
nothing is deleted yet; after login, startup's `retryPoisonMarks` finds the
row, `rebaseAuthoritative("poison")` succeeds, and `deleteBatch` removes an
edit the server never received. Triggers: session expiry, a rotated secret, a
cleared cookie. No queue, provider or e2e test sends a 401 to the queue.

Design: spec § F4 — one Functional Core predicate `isTerminalRejection` in
`web/src/sync/rejection.ts`: a 4xx is terminal unless it is 401, 403, 408 or
429, which take the network-failure path (backoff, head retained, nothing
poisoned). The `/login` navigation still happens; durable rows survive it,
lane entries die with the tab unless the desktop unload guard holds (F9's
territory).

## Todo

- [x] Failing queue tests, lane and durable: 401 and 429 leave the batch retained and unpoisoned with no localStorage intent and it delivers on the next 200; 400, 409 and 422 stay terminal
- [x] `isTerminalRejection` in `web/src/sync/rejection.ts`; both sites call it
- [x] E2E: edit a test page, clear the session cookie, the drain hits 401 and redirects, log in, the edit is on the server (do not write today's journal; delete what the spec creates)
- [x] Docs: `sync-recovery.md` failure-modes row for these statuses; qualify every "4xx" that means rejected in `sync-recovery.md` and `sync-and-offline.md`; troubleshooting row
- [x] verify (web verification suite + the new e2e spec, run three times); perf and merge are out of scope for this worktree (parallel-agent execution: the orchestrator runs `perf/check.sh` and merges after all sibling beans land — see the branch report)

## Summary of Changes

- Added `web/src/sync/rejection.ts`: `isTerminalRejection(error): error is ApiError`, a Functional Core predicate. True only for an `ApiError` with status in `[400, 500)` that is not 401, 403, 408 or 429; false for those four, for a 5xx, and for any non-`ApiError` failure.
- Wired it into both `opQueue.ts` delivery sites (`deliverLaneHead`'s catch, and the durable drain's `postOps` catch), replacing the bare `error instanceof ApiError && status in [400,500)` range check. `failed(error)` (retained, backoff, no `localStorage` write, no `onDesync`) now runs for 401/403/408/429 exactly as it already does for a 5xx or a network error.
- New unit tests in `web/src/sync/opQueue.replica.test.ts`: `test.each([401, 429])` retry-later blocks for both the durable and lane paths (batch/op retained, unpoisoned, no poison-mark intent, delivers on the backoff retry), plus `test.each([409, 422])` pins confirming those stay terminal (poison/discard unchanged) on both paths. A 401 case needed `setUnauthorizedHandler` stubbed in the test (jsdom cannot navigate; see the file's own comment) — a deviation from the plan's literal test code, needed for the suite to run in jsdom at all.
- New e2e spec `web/e2e/auth-retry.spec.ts`: creates a page through the client's own search-bar flow, blocks `/api/ops` (not the whole network — the plan's `context.setOffline` approach deadlocks because the queue's HTTP delivery is gated on the websocket's "connected" status, and a cleared cookie also 403s the socket's own reconnect) to hold an edit undelivered, clears cookies, unblocks `/api/ops`, and confirms the real 401 redirects to `/login` and the edit survives login to land on the server. Confirmed red against the pre-fix predicate (repair deletes the edit, `waitForServerText` times out) before wiring the fix, and green three runs in a row after.
- Docs: `sync-recovery.md`'s failure-modes table now has a terminal-4xx row and a new 401/403/408/429 row; the `A batch the server rejects` section documents `isTerminalRejection`; every bare "4xx" that meant "rejected" in `sync-recovery.md` and `sync-and-offline.md` (including the reconnect-drain mermaid sequence, which gained its own retry-later branch) is now qualified as terminal. One new `docs/troubleshooting.md` row under Sync and offline, keyed to `pkm-jyx1`.
