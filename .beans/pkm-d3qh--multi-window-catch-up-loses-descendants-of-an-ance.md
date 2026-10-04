---
# pkm-d3qh
title: Multi-window catch-up loses descendants of an ancestor moved out then deleted
status: completed
type: bug
priority: normal
created_at: 2026-10-03T16:10:14Z
updated_at: 2026-10-04T14:03:39Z
parent: pkm-nws9
---

Found in review of pkm-pp7q. D > A > K > L; s1 move A to top; s2 delete D; s3 move K to top; s4 delete A. Server ends K > L. A replica catching up in windows of 1-2 rows ends with K and no L: A's s1 move row hydrates to nothing (A is absent now and its delete row is in a later window), D's tombstone cascades the replica's stale D > A > K > L, K returns with its s3 row, L's row never changes so it is never re-shipped. Not a regression (the old tombstone rule loses L too). Production windows split at 1000 rows, so a large catch-up can hit it. Scratch repro: server tests' _catch_up helper with limit 1 or 2. Candidate fix (proposed 2026-10-03, deferred by Arthur): a block tombstone removes exactly that block; local children the window did not tombstone are detached (parent cleared) until their own rows or tombstones arrive — converges because the server journals every block it deletes. Pinned by a strict xfail server test; the sync property does not draw small windows until this is fixed.

- [x] Design (detach-not-cascade or alternative)
- [x] Fix; flip the strict xfail
- [x] Re-enable small window limits in the sync property's arbitraries

## Summary of Changes

Option C (Arthur, 2026-10-04): block tombstones wait for the window that reaches the journal head. applyWindow records a short-of-head window's block tombstones in sync_client_meta["deferred_block_tombstones"] as {cursor, uids}, in the cursor's transaction; the head window applies them (today's cascade) after its upserts and clears the record; applySnapshot clears it. A recorded uid a later window ships live (undo recreates under old uids) leaves the record. A record whose cursor is not the stored cursor is void (an older build on the same replica advanced past it, cascading per window itself). Server _catch_up models the rule; the strict xfail now passes. Sync property draws window limits 1-5 one example in three again (~1000 of 3200 per run, all green). Final review (opus, adversarial): 0 critical/important; reproduced one transient exposure (a pending move of a kept block under a lingering deleted block loses it locally until the skip echo), documented in sync-and-offline.md. Docs: sync-and-offline, backend, sync-recovery, frontend, property-checks, troubleshooting.
