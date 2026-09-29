---
# pkm-l3cr
title: Name memory-only unsent edits in the offline banner, not only the replica-unavailable banner
status: todo
type: task
priority: normal
created_at: 2026-09-29T13:20:43Z
updated_at: 2026-09-29T13:20:43Z
parent: pkm-a4t2
---

Review F9 (documented gap; Fable C3, an accepted limitation under pkm-0htf).
A replica that opens and then fails every write keeps the user's edits in
the in-memory fallback lane. `availabilityOf` returns null for a plain
`ReplicaError`, the "exist only in memory" sentence renders only inside
`ReplicaUnavailableBanner`, and the unload guard is desktop-only, so the
state looks like healthy offline queueing.

Decision (Arthur, 2026-09-29): show the existing sentence whenever
`unsentInMemory > 0` and the socket is not connected, outside the unavailable
banner. This narrows pkm-0htf rather than reversing it: the degraded-write
banner it dropped needed a failure counter and a threshold; this is a display
rule over the count pkm-0htf built for the guard. Online, the lane drains
within a drain cycle, so a healthy session never shows it.

Design: spec § F9.

## Todo

- [ ] Failing `OfflineIndicator` tests: renders offline with lane entries; not when connected; not offline with only durable rows pending
- [ ] `OfflineIndicator` reads `unsentInMemory`; the offline `ConnectivityBanner` appends the sentence; the helper is shared with `ReplicaUnavailableBanner`
- [ ] Docs: `sync-recovery.md` § What the UI shows and the F9 failure row, stating it narrows pkm-0htf
- [ ] verify, merge
