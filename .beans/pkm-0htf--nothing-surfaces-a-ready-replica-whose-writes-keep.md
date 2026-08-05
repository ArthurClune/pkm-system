---
# pkm-0htf
title: A beforeunload guard for undelivered in-memory ops
status: completed
type: bug
priority: normal
created_at: 2026-08-04T19:51:12Z
updated_at: 2026-08-05T15:27:48Z
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

## Decision (2026-08-05): the guard only

Descoped to the `beforeunload` guard. The degraded-write banner is dropped, not
deferred: it needs a consecutive-failure counter that nothing in `opQueue`
keeps today (`noteReplicaFailure` latches only session-fatal evidence), a new
emitter through `SyncProvider`, and a "repeated" threshold no one can validate
— and it fires only in a state where the pending count is already on screen and
the guard below is what actually prevents the loss. There is no client
telemetry, so we cannot say whether a ready-replica write-failure streak has
ever happened in prod; that argues for the cheap guard that helps whatever the
cause, not the elaborate signal tuned to a guess.

The guard is gated on undelivered **in-memory** ops, not on `pending`. `pending`
merges the durable queue rows, which survive a reload perfectly well, so
gating on it would interrupt ordinary healthy offline reloads that risk
nothing. `opQueue` has exactly one `fallback.push`, on the persist-failure
path, so a lane-gated guard is silent in every healthy session — and in an
online-only session (`createLegacyQueue`) the whole queue is in memory, which
is the pkm-bjae case the banner's own Reload confirm was added for.

Registration is conditional on there being something to lose, because a
permanently-attached `beforeunload` listener disables the browser's
back/forward cache.

Known limit, recorded rather than solved: `beforeunload` is unreliable in an
iOS standalone PWA (the same context that suppresses `window.confirm`, hence
`useConfirm`). This is mainly a desktop protection, and the docs must not claim
otherwise. Needs a real-device check.

## Checklist

- [x] `opQueue` exposes undelivered in-memory ops separately from `pending`,
      from both factories (the replica queue's lane; the legacy queue's whole
      in-memory queue)
- [x] `SyncProvider` carries it on the context
- [x] A guard registers `beforeunload` only while that count is non-zero
- [x] Test that an unload with in-memory ops present is intercepted, and that
      one with only durable rows pending is not
- [x] Keep pkm-s1m8's banner copy conditional: the guard does not hold on iPad,
      so the unconditional reassurance would be a claim we cannot make
- [x] Update docs/architecture/sync-and-offline.md (the fallback-lane section,
      the two tables that assert "there is no `beforeunload` anywhere", and the
      hazard row at the end)
## Summary of Changes

`opQueue` now emits the fallback lane's length on `onUnsentInMemory`, from the
one `emitPending()` choke point every lane mutation already goes through.
`SyncProvider` carries it as `Sync.unsentInMemory` and passes it to
`useUnloadGuard` (`web/src/sync/unloadGuard.ts`), which attaches a
`beforeunload` listener only while that count is non-zero. `createLegacyQueue`
gets an honestly-inert stub: `createOpQueue` builds it only when
`replica === null`, which `defaultReplica()` returns only where `Worker` is
undefined, so it never runs in a real browser.

`OfflineIndicator` is unchanged. Its Reload confirm and its connectivity-
conditional copy both stay, because the guard does not hold on iPad.

Tests: the lane count is asserted both ways in `opQueue.replica.test.ts` (a
retained op reads 1 and returns to 0 on delivery; a durable offline row leaves
it at 0 while `onPending` reads 1), the listener's own behaviour in
`unloadGuard.test.tsx`, and the wiring in `SyncProvider.test.tsx`. That last
pair is the one that matters for regressions: substituting `pending` for
`unsentInMemory` in the provider fails the durable-row test with
`expected true to be false`, which was verified by making that substitution
deliberately before keeping the test.

Verified: `pnpm verify` end to end (typecheck, lint, FCIS, coverage 97.67%
statements with `unloadGuard.ts` at 100%, 2011 unit tests, 51 Playwright specs)
and `pytest -q` (1428 passed), though nothing server-side changed.

Not done, and recorded rather than forgotten: the degraded-write banner is
dropped (see the decision above), and `beforeunload` behaviour in an iOS
standalone PWA has not been checked on a real device. The docs and the code
comments describe this as a desktop protection for that reason, so no shipped
claim depends on it.
