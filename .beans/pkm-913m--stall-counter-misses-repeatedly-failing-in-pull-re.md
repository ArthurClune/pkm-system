---
# pkm-913m
title: Stall counter misses repeatedly-failing in-pull recovery (synthetic error is network-shaped)
status: completed
type: bug
priority: low
created_at: 2026-07-22T12:43:37Z
updated_at: 2026-07-23T20:38:39Z
---

Follow-up from pkm-80ds final review fixes: pullLoop's needs-bootstrap path rethrows a synthetic plain Error, which isStallShaped() classifies as network-shaped, so repeated in-pull recovery failures no longer count toward mode:stalled. User-visible impact is minimal (each attempt still reports recovery-failed -> same replica-stalled banner when connected, and ready re-emission on later success works), but the classification masks the underlying error type. Fix idea: preserve/rethrow the original error from recover()'s failure instead of a synthetic one, or mark the synthetic error stall-shaped.

## Summary of Changes

Root cause: `recover()` in `web/src/sync/replicaSync.ts` swallowed the
underlying error from `runRecovery()` and returned a plain `boolean`. In
`pullLoop`'s needs-bootstrap path, a failed `recover("rebase")` then threw a
synthetic `new Error("replica recovery failed during pull")`. `isStallShaped`
classifies by `instanceof` (`ApiError | ReplicaError | PullStarvedError`), so
that synthetic plain `Error` always read as network-shaped, and repeated
in-pull recovery failures never advanced `consecutiveFailures` toward
`STALL_AFTER_FAILURES` -- regardless of whether the real underlying failure
(e.g. a `ReplicaError` from a rejected RPC) was in fact stall-shaped.

Fix taken: the first fix idea from the bean -- preserve/rethrow the original
error. Changed `recover()`'s return type from `Promise<boolean>` to
`Promise<{ ok: true } | { ok: false; error: unknown }>` so callers can see
the real failure. `pullLoop`'s needs-bootstrap path now does
`throw rebased.error` instead of minting a synthetic Error, so
`isStallShaped` sees the original error type. `doStart`'s other `recover()`
call site (schema-mismatch reset) only needed the success/failure boolean,
so it was updated to check `.ok` and continue discarding the error (it
already reports failure via `runRecovery`'s own `onState` call and just
returns without a further throw). This is a smaller, more targeted change
than marking the synthetic error stall-shaped by fiat, and it makes the
stall counter reflect the true error type as the bean requested, rather than
special-casing one call site's synthetic error class.

Files changed:
- `web/src/sync/replicaSync.ts` -- `recover()` return type + both call sites.
- `web/src/sync/replicaSync.test.ts` -- two new tests (TDD): repeated
  in-pull recovery failures with a stall-shaped underlying error (`ReplicaError`)
  now stall at 3; repeated in-pull recovery failures with a genuinely
  network-shaped underlying error (`TypeError: Failed to fetch`) still never
  stall.

Verification:
- `cd web && pnpm vitest run src/sync/replicaSync.test.ts` -- 36/36 passed
  (new tests initially failed pre-fix as expected, then passed post-fix).
- `cd web && pnpm typecheck` -- clean.
- `cd web && pnpm verify` -- typecheck/lint/check:fcis/test:coverage all
  passed; Playwright e2e: 32/33 passed, the one failure
  (`e2e/backlink-filter.spec.ts`) is on the task's documented known-flaky
  list (resyncSeq remount churn, "element was detached from the DOM,
  retrying") and passed on isolated rerun with `--retries=2`. Unrelated to
  this change (sync-engine error classification only, no editor/backlink UI
  touched).

Branch: `fix/pkm-913m-stall-counter-classification`.
