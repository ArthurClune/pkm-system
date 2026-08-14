---
# pkm-a1gh
title: Poison repair on iPad PWA stalls across relaunches (slow rebuild, no progress signal)
status: todo
type: bug
created_at: 2026-08-14T16:35:55Z
updated_at: 2026-08-14T16:35:55Z
---

Observed 2026-08-14 after the duplicate-batch 400 (see the enqueue lost-reply bean): the poison repair (markPoisoned -> rebaseAuthoritative -> snapshot -> commitRecovery rebuild -> deleteBatch -> resume) fetched /api/sync/snapshot at 17:12:32, 17:14:40 and 17:18:42 from the iPad without ever resuming delivery; pending stuck at 17. It eventually completed once the app was kept foregrounded.

Working theory: the full replica rebuild (~54k blocks, 21MB DB) takes long enough on an iPad that backgrounding/locking kills it mid-rebuild; every relaunch restarts the repair from scratch. The user just sees "Repairing local state…" with no progress and no hint to stay foregrounded.

Needs client-side evidence before fixing (server logs cannot see where commitRecovery dies). Candidate angles:
- Instrument repair phases (timings, failure point) somewhere retrievable
- Make the repair resumable or cheaper (only the poisoned row's page actually needs authority?)
- UI: progress/keep-app-open hint during repair
- Reproduce in the iPad simulator (see ipad-simulator-testing-recipe memory)

Aug 6 had the same 400+repair signature (server.out.log line ~56477) and recovered quickly — the wedge is load/timing dependent, not deterministic.
