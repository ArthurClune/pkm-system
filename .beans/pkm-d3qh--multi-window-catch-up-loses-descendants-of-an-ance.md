---
# pkm-d3qh
title: Multi-window catch-up loses descendants of an ancestor moved out then deleted
status: todo
type: bug
created_at: 2026-10-03T16:10:14Z
updated_at: 2026-10-03T16:10:14Z
parent: pkm-nws9
---

Found in review of pkm-pp7q. D > A > K > L; s1 move A to top; s2 delete D; s3 move K to top; s4 delete A. Server ends K > L. A replica catching up in windows of 1-2 rows ends with K and no L: A's s1 move row hydrates to nothing (A is absent now and its delete row is in a later window), D's tombstone cascades the replica's stale D > A > K > L, K returns with its s3 row, L's row never changes so it is never re-shipped. Not a regression (the old tombstone rule loses L too). Production windows split at 1000 rows, so a large catch-up can hit it. Scratch repro: server tests' _catch_up helper with limit 1 or 2. Candidate fix (proposed 2026-10-03, deferred by Arthur): a block tombstone removes exactly that block; local children the window did not tombstone are detached (parent cleared) until their own rows or tombstones arrive — converges because the server journals every block it deletes. Pinned by a strict xfail server test; the sync property does not draw small windows until this is fixed.

- [ ] Design (detach-not-cascade or alternative)
- [ ] Fix; flip the strict xfail
- [ ] Re-enable small window limits in the sync property's arbitraries
