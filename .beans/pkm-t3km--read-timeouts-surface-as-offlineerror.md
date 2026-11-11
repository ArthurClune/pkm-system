---
# pkm-t3km
title: Read timeouts surface as OfflineError
status: scrapped
type: bug
priority: low
created_at: 2026-11-11T12:49:54Z
updated_at: 2026-11-11T13:19:30Z
parent: pkm-4gda
---

For a route the shim does not serve, a read timeout while the gateway is installed surfaces as OfflineError, not as a timeout. isStallShaped excludes both, so nothing miscounts, but logs say offline for a slow server. W11's Task 4 exempted only the stall. Finding D in docs/superpowers/plans/2026-11-11-w11-recovery-lease.md.


## Reasons for Scrapping

Only a log label is wrong: isStallShaped excludes both errors, so nothing miscounts. (Arthur, 2026-11-11.)
