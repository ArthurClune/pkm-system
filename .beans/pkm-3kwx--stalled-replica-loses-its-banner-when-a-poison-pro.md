---
# pkm-3kwx
title: Stalled replica loses its banner when a poison problem ends
status: in-progress
type: bug
priority: normal
created_at: 2026-11-12T15:48:43Z
updated_at: 2026-11-12T17:29:31Z
---

Symptom: while the local replica is stalled, a poison problem (a rejected batch) takes the banner. When that problem ends (the failed mark is discarded, discovery clears, or Dismiss on the `repaired` notice), no banner shows at all, although the replica is still stalled. The `replica-stalled` banner only returns at the next stall report: `noteFailure` re-reports on each failed retry (backoff capped at `RETRY_MAX_MS`, 60 s), and arms no timer while offline, so offline it stays bannerless until a reconnect fails.

Cause: in `web/src/sync/syncState.ts`, `poisonProblem` replaces a shown `replica-stalled` problem outright (only an outline problem is held behind), and `poisonEnded` / `dismiss` set the problem to undefined rather than falling back to the stall that is still true.

Ruling (Arthur, 2026-11-12): a stalled replica should never be bannerless. A poison problem still outranks the stall while it lasts (contracts/sync-recovery.md § What the UI shows), and `repaired` keeps outranking it.

Found while writing pkm-k2lf's banner row. When fixed, give `sync/bannerModel.ts` the case too (see the follow-up bean that models poison beside a stall).

- [x] Failing unit test in syncState.test.ts: stall, then poison, then poison ends -> replica-stalled shown
- [x] Fix: remember the stall behind a poison problem and restore it when the poison ends
- [x] Row in contracts/sync-recovery.md § What the UI shows
- [x] pnpm verify; proptest/check.sh web

- [x] `pnpm verify` passed (proptest/check.sh web still open, above)
