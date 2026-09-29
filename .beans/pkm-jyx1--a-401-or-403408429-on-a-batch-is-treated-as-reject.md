---
# pkm-jyx1
title: 'A 401 (or 403/408/429) on a batch is treated as rejection: poisoned or dropped, then deleted by the repair after login'
status: todo
type: bug
priority: high
created_at: 2026-09-29T13:20:31Z
updated_at: 2026-09-29T13:20:31Z
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

- [ ] Failing queue tests, lane and durable: 401 and 429 leave the batch retained and unpoisoned with no localStorage intent and it delivers on the next 200; 400, 409 and 422 stay terminal
- [ ] `isTerminalRejection` in `web/src/sync/rejection.ts`; both sites call it
- [ ] E2E: edit a test page, clear the session cookie, the drain hits 401 and redirects, log in, the edit is on the server (do not write today's journal; delete what the spec creates)
- [ ] Docs: `sync-recovery.md` failure-modes row for these statuses; qualify every "4xx" that means rejected in `sync-recovery.md` and `sync-and-offline.md`; troubleshooting row
- [ ] verify, perf, merge
