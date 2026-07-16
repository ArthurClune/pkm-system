---
# pkm-ss9k
title: 'Offline-shell E2E flake: resyncSeq remount churn'
status: completed
type: bug
priority: normal
created_at: 2026-07-16T13:01:52Z
updated_at: 2026-07-16T15:28:46Z
---

The offline-shell cold-start E2E (web/e2e/offline-shell.spec.ts, 'cold start offline' test) can fail once in a full-suite run with Playwright's 'element is visible, enabled but not stable' timeout while clicking a journal block in the ONLINE phase. Observed once on 2026-07-16 during the pkm-c1cg final verification; passed 4/4 isolated re-runs and two subsequent full verifies.

The pkm-c1cg final review adjudicated it as the pre-existing resyncSeq remount churn (documented during the offline epic pkm-y8p0): after earlier specs leave journal content and sync churn behind, a resyncSeq bump remounts the tree while Playwright's stability check is looping. The Task 10 reviewer ruled out the epic's suppression conversions as the cause.

- [x] Reproduce under full-suite conditions (run e2e specs in sequence against a dirty server db).
- [x] Fix the underlying remount churn (avoid full-tree remount on resyncSeq bump, or make the journal block identity stable across bumps) OR make the test robust to a single remount if churn is by design.
- [x] Full pnpm verify green x3 consecutive runs.

## Summary of Changes

Root cause: `Journal.reset()` (the `useResync` handler) called `setDays([])`
before the authoritative refetch, unmounting every `.journal-day` section and
remounting it when the head reload landed. The remount was vestigial — it
predates the shared outline-session architecture (ca13148/4948566), which
already pushes fresh authoritative blocks into mounted `EditablePage`s via
`session.receiveAuthoritative` -> `handle.subscribe`. Any resync bump landing
while Playwright's actionability loop was mid-click on a journal block
produced the "not stable"/"element detached" retry-loop timeout.

Reproduction: unit test pinning DOM identity across a resyncSeq bump failed
pre-fix (new element after resync). E2E: a temporary 60ms resyncSeq bump
interval in SyncProvider (amplification, removed before commit) made the full
suite fail 4/7 with "element was detached from the DOM, retrying" on journal
interactions; with the fix, the same amplified suite passed 7/7.

Fix (root-cause route, in `web/src/views/Journal.tsx`):
- `reset()` no longer blanks `days`/`refTexts`; it only resets the pagination
  cursor (`daysRef`) and reloads. The head reload replaces the day list in
  place under stable per-date keys, so no section unmounts.
- `loadMore` now replaces (rather than merges) the block-ref-text map on a
  head load so stale resolutions can't linger after a resync.
- New unit test "keeps day sections mounted across a resync (no remount
  churn)" locks the DOM-identity invariant; the existing stale-in-flight
  discard test still passes unchanged.

Verification: `pnpm verify` (E2E_PORT=8981) green three consecutive runs,
each ending "7 passed" on the e2e suite.
