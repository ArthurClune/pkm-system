---
# pkm-d7e1
title: A changes window that fails to apply for any non-FK reason refetches forever
status: completed
type: bug
priority: normal
created_at: 2026-09-03T09:22:53Z
updated_at: 2026-09-03T09:39:59Z
---

Found auditing pkm-n31j. applyChanges maps three failure classes to needs-bootstrap (deferred FK at COMMIT, a still-parked title holder, corruption via replicaSync). Every other deterministic failure of applyWindow -- a NOT NULL or CHECK violation from a malformed feed, a bug in upsertBlock or reconcilePage -- rolls the window back, leaves the cursor in place, and the stall backoff refetches the identical window until the user presses Reset local data. That is the wedge shape both pkm-qvlx and pkm-n31j had; each fix has added one class to the whitelist. Proposal to decide: after N consecutive failures of the SAME cursor with the same error text, treat the window as unappliable and rebootstrap (rebase), keeping the stall banner only for failures a snapshot also cannot clear. Cost: hides a feed bug behind a resync (the reason applyFkHazards.test pins that non-FK failures throw); mitigated by posting the failure through /api/client/diagnostics (pkm-1mx9) before rebootstrapping.

## Checklist

- [x] Count identical window failures in `pullLoop` (`isWindowFailure` +
      `noteWindowFailure`: same cursor, same message; reset on `noteSuccess`
      and on any adopted cursor)
- [x] Export `WINDOW_STRIKES`, tied to `STALL_AFTER_FAILURES` so the rebase
      always lands before the stall banner
- [x] Generalise `reportCorruption` into `reportReplicaProblem(kind, error)`
      and post kind `window-unappliable`
- [x] Rebase (not reset) once per session, spending the budget only on a
      rebase that succeeded; poison repair still owns the lease
- [x] Leave `apply.ts` and `applyFkHazards.test.ts` untouched
- [x] Tests: strikes rebase before the banner, different messages, moving
      cursors, `ApiError`, second run stalls, failed snapshot keeps the budget
- [x] `docs/architecture/sync-and-offline.md`: seventh rebootstrap trigger
- [x] `pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:unit`,
      then `CI=true pnpm verify`

## Summary of Changes

`web/src/sync/replicaSync.ts` now decides what to do about a changes window
that keeps throwing, so the general case self-heals instead of being refetched
forever behind the "Local sync is stuck" banner.

- `isWindowFailure` classifies a failure as belonging to the window itself: a
  `ReplicaError` that is not corruption (that branch runs first and needs a
  `reset`) and carries no availability verdict. `ApiError`, `OfflineError` and
  raw `fetch` rejections are about the transport and never count.
- `noteWindowFailure` tracks `{ cursor, message, count }`. Same cursor and same
  message increments; anything else restarts at 1. `noteSuccess` and
  `adoptCursor` clear it.
- `WINDOW_STRIKES = STALL_AFTER_FAILURES` (3). Both counters advance once per
  failed pull, but the window count is taken inside `pullLoop` and
  short-circuits the throw, so the third identical failure rebases instead of
  becoming `noteFailure`'s third increment. One higher and the banner would be
  raised first.
- On reaching the strikes, `rebaseForUnappliableWindow` posts
  `replica.diagnostics()` plus the error text to `POST /api/client/diagnostics`
  under kind `window-unappliable`, defers if a poison repair owns recovery,
  then runs `recover("rebase")` — a rebase, because nothing here says the
  schema or the FTS index is bad and a rebase keeps the pending queue's rows.
- One rebase per session, and the budget is spent only when a rebase succeeds
  (a failed snapshot fetch leaves it for the retry). A second run of identical
  failures falls through to the ordinary stall banner, which is where a feed
  bug should become visible.
- `reportCorruption` is now `reportReplicaProblem(kind, error)` shared by both
  self-heal paths.

`apply.ts` is unchanged: it still throws for everything outside its
`needs-bootstrap` whitelist, and `applyFkHazards.test.ts` still pins that.

Six tests in `web/src/sync/replicaSync.test.ts`; a seventh trigger row in
`docs/architecture/sync-and-offline.md` (its "Six conditions" count corrected
to seven).
