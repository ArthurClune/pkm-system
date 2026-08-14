---
# pkm-a1gh
title: Poison repair on iPad PWA stalls across relaunches (slow rebuild, no progress signal)
status: completed
type: bug
priority: normal
created_at: 2026-08-14T16:35:55Z
updated_at: 2026-08-14T17:53:19Z
---

Observed 2026-08-14 after the duplicate-batch 400 (see the enqueue lost-reply bean): the poison repair (markPoisoned -> rebaseAuthoritative -> snapshot -> commitRecovery rebuild -> deleteBatch -> resume) fetched /api/sync/snapshot at 17:12:32, 17:14:40 and 17:18:42 from the iPad without ever resuming delivery; pending stuck at 17. It eventually completed once the app was kept foregrounded.

Working theory: the full replica rebuild (~54k blocks, 21MB DB) takes long enough on an iPad that backgrounding/locking kills it mid-rebuild; every relaunch restarts the repair from scratch. The user just sees "Repairing local state…" with no progress and no hint to stay foregrounded.

Needs client-side evidence before fixing (server logs cannot see where commitRecovery dies). Candidate angles:
- Instrument repair phases (timings, failure point) somewhere retrievable
- Make the repair resumable or cheaper (only the poisoned row's page actually needs authority?)
- UI: progress/keep-app-open hint during repair
- Reproduce in the iPad simulator (see ipad-simulator-testing-recipe memory)

Aug 6 had the same 400+repair signature (server.out.log line ~56477) and recovered quickly — the wedge is load/timing dependent, not deterministic.

## Descoped 2026-08-15 (Arthur)

A simple 'keep the app open' hint on the repairing banner is fine for now. The instrumentation / resumable-rebuild / simulator-repro angles are explicitly NOT being pursued unless the stall recurs and matters.

## Tasks

- [x] Failing test: repairing banner includes the keep-the-app-open hint
- [x] Add the hint to the repair-running banner copy in OfflineIndicator.tsx
- [x] cd web && pnpm verify (typecheck, unit coverage, 53 e2e — green)

## Summary of Changes

Descoped per Arthur to the banner hint alone. The rejected-batch repairing banner in OfflineIndicator.tsx now reads: 'Server rejected a change (HTTP <status>). Repairing local state… Keep the app open until this finishes.' — with a code comment explaining why (iOS freezes a backgrounded PWA mid-rebuild; each relaunch restarts the repair, pkm-a1gh). Unit test updated to pin the full copy. The deeper angles (instrumentation, resumable rebuild, simulator repro) were considered and dropped for now; revisit only if a stall recurs despite the hint.
