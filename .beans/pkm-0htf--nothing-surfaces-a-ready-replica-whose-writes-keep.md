---
# pkm-0htf
title: Nothing surfaces a ready replica whose writes keep failing, and its lane ops die on reload
status: todo
type: bug
priority: normal
created_at: 2026-08-04T19:51:12Z
updated_at: 2026-08-04T19:51:12Z
---

Filed from pkm-avag's decision. Deleting the quota chain removed an
*untriggerable* read-only mode; the hazard it was aimed at is real and broader
than quota, and now has no cover at all.

## The gap

The replica opens fine (`mode: "ready"`), but its writes fail persistently — an
exhausted disk (`SQLITE_IOERR`), a starved SAH pool (`SQLITE_CANTOPEN`,
pkm-ndcu), anything else the VFS reports. `opQueue` correctly retains each op in
the in-memory fallback lane and delivers it on the next drain, so nothing is
lost while the tab lives and the socket is up.

Nothing tells anyone this is happening:

- `availabilityOf(error)` returns `null` for these failures (they are neither
  `unusable` nor `unreachable`), so `SyncProvider` raises no `problem` and
  `OfflineIndicator` shows no banner.
- `computeEditability` sees `replicaMode === "ready"` and keeps editing enabled,
  which is right — the writes still reach the server — but it means the user
  keeps producing ops that only ever exist in memory.
- The only surface is the pending count in the ordinary offline banner, which
  looks identical to healthy offline queueing.

Then the ops die quietly: there is no `beforeunload` anywhere in `web/src`, so a
refresh or a closed tab discards the lane. The confirm that pkm-bjae added lives
on the replica-unavailable banner's own Reload button, which never renders here.
Contrast `resetReplica`, which refuses outright with unsent work.

## Why the old mechanism did not cover it

`computeEditability`'s read-only branch only fired when `quotaExhausted` was
set, and nothing could set it: the opfs-sahpool VFS turns the
`QuotaExceededError` DOMException into a bare `SQLITE_IOERR` (pkm-avag). It also
only bit *offline* — `canEdit` is true whenever `status === "connected"` — so
even a working flag would have said nothing in the common case.

## Candidate fixes (not yet decided)

- A `beforeunload` guard whenever undelivered lane ops exist, whatever put them
  there. This is the deferred option 4 from pkm-s1m8, and it is the piece that
  makes any "your changes are safe" claim true rather than conditional.
- A banner for repeated local-persistence failure on a ready replica: say that
  offline editing is degraded and this tab is now the only copy. Needs a
  threshold, since one transient failure is normal and self-healing.
- Do neither, and accept that the pending count is the whole signal — defensible
  only if the lane is judged reliable enough, which the absence of a
  `beforeunload` argues against.

## Checklist

- [ ] Decide whether the `beforeunload` guard is unconditional for undelivered
      lane ops (simplest honest rule) or gated
- [ ] Decide whether repeated ready-replica write failures deserve their own
      banner, and what threshold counts as "repeated"
- [ ] Implement, with a test that a reload with lane ops present is intercepted
- [ ] Revisit pkm-s1m8's conditional banner copy: a working guard would let the
      reassurance be unconditional again
- [ ] Update docs/architecture/sync-and-offline.md (fallback-lane section, and
      the "no beforeunload anywhere" claim if it stops being true)
