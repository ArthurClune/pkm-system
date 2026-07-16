---
# pkm-wggr
title: Sync shell minor cleanups from epic final review
status: completed
type: task
priority: normal
created_at: 2026-07-16T12:08:59Z
updated_at: 2026-07-16T13:32:25Z
---

Three Minor findings from the pkm-c1cg final whole-branch review (all in sync shells, none merge-blocking):

- [x] SyncProvider.tsx:152-160: applySync computes transitions from problemRef.current which is refreshed only at render; two same-tick dispatches share a stale prev. Update problemRef.current inside applySync after setProblem.
- [x] opQueue.ts:356-377: replica queue kick landing between the drain's final drainAgain check and .finally clearing drainRun is dropped (legacy queue has missedKick; replica does not). Add a drainAgain re-check in finally or document the window.
- [x] opQueue.ts:576: unreachable continue after the poison path. Delete or comment as deliberate defense.

## Summary of Changes

1. **applySync staleness**: `problemRef.current` is now updated immediately inside
   `applySync` right after `setProblem`, so a second `applySync` dispatched in the
   same render batch reads the freshest problem instead of the value from the
   last commit. Reproduced RED first with a new test in `SyncProvider.test.tsx`
   ("applySync reads the freshest problem for same-tick dispatches: a dismiss
   racing a new repair-started must not erase it"): with the bug, a same-tick
   pair of (repair-started, dismiss) caused `dismissProblem()` to read a stale
   "repaired" snapshot and wrongly erase the live "running" repair problem
   (`sync.problem` went to `undefined` instead of staying `{kind: "rejected-batch",
   repair: "running", ...}`). Fix made it GREEN; full SyncProvider suite (35
   tests) still passes.

2. **opQueue.ts drain missed-kick window**: added a re-check of `drainAgain` in
   the drain promise's `.then()` (replacing the old bare `.finally()`), scoped
   *only* to a `"drained"` outcome — a kick() landing after the loop's own
   final drainAgain check but before `drainRun` is cleared now re-arms a drain,
   mirroring the legacy queue's `missedKick` handling. Deliberately NOT applied
   to blocked outcomes (offline/recovering/disposed/retryable): an initial
   attempt that re-kicked unconditionally caused a real regression, caught by
   the existing suite (`opQueue.replica.test.ts` — "offline: batches persist
   without posting; reconnect drains in order" started failing, missing the
   second batch), traced down to a genuine race — a caller sharing the
   in-flight (now-completing) drainRun promise via `drain()`'s "if (drainRun)
   return drainRun" path would observe the stale blocked result instead of
   the background re-kick's outcome, since that re-kick is never chained into
   the promise the caller is awaiting. Scoping the fix to "drained" avoids
   this because a blocked outcome's reason still holds regardless of any kick
   during cleanup, so there's nothing to usefully re-arm. Did not add a
   dedicated unit test for the exact race window: it requires landing code
   between `runDrain()`'s internal return and the `.then()` callback actually
   running (2 microtask hops via `.catch().then()`), and every mock hook
   available (nextBatch, deleteBatch, postOps) necessarily resolves *before*
   that window, not inside it — there is no whitebox-free way to inject code
   there. Verified via manual trace instrumentation (added temporarily, then
   removed) that the fix takes effect and does not regress the full
   opQueue.test.ts / opQueue.replica.test.ts / SyncProvider.test.tsx suites
   (88 tests) or the wider `pnpm test:unit` (1022 tests). Left a code comment
   naming the window and explaining the "drained"-only scoping at the fix site.

3. **opQueue.ts:576 dead `continue`**: confirmed unreachable — the preceding
   `dispatch({ type: "pause" })` unconditionally sets `qstate.recovering = true`
   (see `queueState.ts`'s "pause" case), so `if (qstate.recovering) return
   terminal("recovering", error);` always fires; the `continue` on the next
   line can never execute. Deleted it and left a comment explaining why.

Covering suites (`SyncProvider.test.tsx`, `opQueue.test.ts`,
`opQueue.replica.test.ts` — 88 tests) all pass, as does the full
`pnpm test:unit` (1022 tests) and `pnpm typecheck`.
