---
# pkm-wi25
title: block-stamps e2e flakes ~1 in 5 on its post-reload stamp assertion
status: completed
type: bug
priority: normal
created_at: 2026-08-03T20:31:54Z
updated_at: 2026-08-04T10:48:50Z
---

`web/e2e/block-stamps.spec.ts:31` ("the page menu toggles a stamp column that
survives a reload") fails roughly one run in five, always at the same place --
line 53, `expect(page.locator(".block-stamp").first()).toBeVisible()`, the
assertion just after `page.reload()`. Error is "element(s) not found" after the
5s timeout. Everything before the reload passes, so the toggle itself and the
first stamp render are fine.

Found while shipping pkm-xrfq (page-menu label flip). Confirmed **pre-existing**
and unrelated to that change: stashed the branch, rebuilt, ran the spec 5x
against unmodified code -> 1 failure; ran it 5x with the change -> 0 failures.
It also passed in two full `pnpm verify` runs, so the whole-suite run is not
where it shows up -- it surfaces when the spec runs alone.

## Leading hypothesis (untested)

The block is created by typing into the textarea, and the reload may land before
that text has been persisted to the replica/server. If the row is gone after the
reload there is no cell to stamp, which matches "element(s) not found" rather
than "found but empty" -- worth distinguishing, since `EditableBlockTree` keeps
an empty `.block-stamp` cell for a block with no timestamps at all
(`EditableBlockTree.test.tsx:765`), so a *present* row would still yield a
locator hit. Alternative: the stamps preference (localStorage) is read before
hydration and the column mounts a beat late, though 5s makes that unlikely.

## Checklist

- [x] Reproduce in a loop (`for i in $(seq 10)`) and capture the post-reload DOM
      on failure -- specifically whether `.block-row` exists at all
- [x] If it is the unflushed block: await a server-side confirmation of the text
      before reloading (not a bare timeout), the way other specs wait
- [x] If it is pref/hydration timing: fix the wait, not the timeout
      (it was not: the preference read is fine, there was simply no row to stamp)
- [x] Decide whether this is only a test-harness race or a real user-visible
      "type then immediately reload loses the block" bug -- the latter is much
      more interesting than the flake

## Root cause (measured, not hypothesised)

Hypothesis 1 was right about the symptom and wrong about the cause. The
post-reload DOM has **no `.block-row` at all** -- the page renders its "Click to
start writing…" placeholder, i.e. zero blocks -- so there is no cell to stamp.
But the block was not merely un-flushed: it was never delivered, and never
would have been.

Instrumented run at the moment of failure (`/api/ops` requests, worker console,
plus polling the server's own copy of the page):

```
[207ms] console.error: pkm-replica: NoModificationAllowedError: Failed to execute
        'createSyncAccessHandle' ... Access Handles cannot be created if there is
        another open Access Handle ...        (x6, one per pooled file, same ms)
[207ms] console.error: pkm-replica removeVfs() failed with no recovery strategy
[269ms] SAH contention seen this run: true
[275ms] t+0:  server=[] banner=[]
[2295ms] t+2: server=[] banner=["Checking rejected changes failed: Failed to
         execute 'createSyncAccessHandle' ... Retry"]
...
[59931ms] t+59: server=[] banner=[same]
          LANDED AT t+-1        <- no reload in this run at all
```

So with the replica's OPFS SAH pool contended at open time, **no `POST /api/ops`
is ever made** -- not in 60s, reload or no reload. The edit is visible on screen
and exists only in memory.

Two mechanisms compose:

1. `openRetry.ts`'s bounded retry was a no-op for this failure. sqlite-wasm
   memoises `installOpfsSAHPoolVfs` per VFS name and, by default, re-awaits (and
   rethrows) a cached *rejection*:
   `if (initPromises[vfsName]) try { return await initPromises[vfsName] } catch (e) { if (options.forceReinitIfPreviouslyFailed) delete initPromises[vfsName]; else throw e }`
   The worker did not pass that flag, so retries 2-6 replayed the first error
   instantly without touching OPFS (visible above: all six handle errors land in
   the same millisecond, then nothing). One transient contention = a dead
   replica for the life of the page. sqlite-wasm documents the flag for exactly
   this case (sqlite/sqlite-wasm#79).
2. With no openable replica, `SyncProvider`'s mount effect never lifts its
   startup gate -- it pauses the queue on the recovery barrier and waits for
   `queue.retryPoisonMarks()` / `replica.poisonedBatches()`, both replica RPCs --
   so the ops sit in the in-memory fallback lane and the queue is never set
   online. Hence the permanent "Checking rejected changes failed" banner and the
   total absence of delivery.

Fixing (1) removes the trigger and the flake. (2) is still reachable with a
*persistent* holder (a second live tab), so it is filed separately as
**pkm-bjae** -- edits accepted, never delivered, lost on reload, warned about
only by a banner that does not mention unsaved work.

## Harness race, or real bug?

**Real bug, in the app, not the test.** The e2e's three full document loads in
~100ms make the contention likely (~1 run in 5), which is why it showed up here
first -- but nothing about the failure is test-only: the browser genuinely
failed to open OPFS, the client genuinely wedged, and the typed block was
genuinely lost with no recovery path. A user hitting the same contention (two
tabs, a fast reload) would lose typed text just as silently.

## Summary of Changes

- `web/src/replica/openRetry.ts`: added `SAH_POOL_INSTALL_OPTIONS`
  (`name: "pkm-replica"`, `forceReinitIfPreviouslyFailed: true`) with the
  rationale, so the existing backoff is a real second attempt rather than a
  replay of a memoised failure.
- `web/src/replica/worker.ts`: installs the pool with those options; its local
  `installOpfsSAHPoolVfs` type widened to match.
- `web/src/replica/openRetry.test.ts`: two tests around a fake that reproduces
  sqlite-wasm's `initPromises` memoisation contract -- with the flag the retry
  really re-attempts (2 OPFS attempts, recovers); without it every retry
  replays the cached rejection (1 OPFS attempt, never recovers).
- `web/e2e/block-stamps.spec.ts`: `waitForServerText(page, title, "a block with
  a date")` before `page.reload()` -- the deterministic server-side wait the
  other specs use, no bare timeout. A future regression of this class now fails
  as "the server never got the text" rather than as a missing stamp column.
- `docs/architecture/sync-and-offline.md`: the install-option caveat on the
  open-retry paragraph, and an honest note that the in-memory fallback lane is
  only drainable once the replica opens -- a permanently unopenable replica is a
  durability hazard, not just a lost cache.

Verification: the spec failed 2/10, 2/8 and 3/8 in cold-start loops before the
fix; 12/12 consecutive passes after. A no-reload probe that had never delivered
in 60s under contention now delivers at t+1s (one run of ten still hit the
contention and recovered through the retry). Full `web` unit + e2e suite green.
