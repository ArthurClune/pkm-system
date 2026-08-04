---
# pkm-avag
title: 'Quota-exhausted read-only mode is unreachable: nothing ever throws quota:true'
status: completed
type: bug
priority: normal
created_at: 2026-08-04T18:18:53Z
updated_at: 2026-08-04T19:51:49Z
---

The web client has a complete mechanism for "local storage is full, go read-only": an error carrying `quota: true` crosses the RPC wire (`rpc.ts` sets `quota: Boolean(e?.quota)`), `opQueue`'s enqueue catch calls `quota.emit(error)`, `SyncProvider` turns that into `quotaExhausted`, and `computeEditability` (`syncState.ts:74-79`) uses it to take editing away for the session.

**Nothing in `web/src` ever throws an error carrying `quota: true`.** Only tests do — `replica/errors.test.ts`, `replica/rpc.test.ts` and `sync/opQueue.replica.test.ts` construct one by hand. Every production site merely *forwards* or *consumes* the flag.

So the whole chain is dead code in production: a user whose OPFS storage actually fills up gets whatever sqlite-wasm really raises, which is not this, and the read-only branch never runs.

## Provenance

Found during epic pkm-q2jj and recorded as a finding on pkm-imw4 (the characterisation task) because it made the chain unpinnable end-to-end — there is no real input to drive it with. Confirmed **pre-existing on main**, not caused by that epic: the base `rpc.ts` had the identical `Boolean(e?.quota)` pass-through. The epic deliberately left the mechanism untouched.

## The decision to make

Either:
- **Wire a real signal** — find out what sqlite-wasm / OPFS actually raise when storage is exhausted, classify it, and set the flag at the point it is raised. This is the only option that makes the read-only UX real.
- **Delete the mechanism** — the flag, `onQuota`, `quotaExhausted`, and `computeEditability`'s branch.

Leaving an untriggerable read-only path in a sync client is the trap: it reads as covered behaviour and will mislead the next person debugging a storage failure.

## Checklist

- [x] Determine what sqlite-wasm/OPFS raise on a genuinely exhausted quota (may need a synthetic small-quota profile)
- [x] Decide: wire it up, or delete the chain
- [x] If wiring: N/A — no origin can identify quota. Original: set `quota` where the error originates, and add a test driving the real error shape
- [x] If deleting: remove the flag from the wire shape, `onQuota`, `quotaExhausted`, and the `computeEditability` branch, plus their tests
- [x] Update `docs/architecture/sync-and-offline.md` if it describes the read-only path


## Summary of Changes

**Decision: deleted the chain.** The signal it needed cannot exist. sqlite-wasm's
opfs-sahpool `xWrite` catches the `QuotaExceededError` DOMException raised by
`SyncAccessHandle.write()`, stores it on the pool's private `$error` and returns
`SQLITE_IOERR` (`web/node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs:14680`),
so what reaches the main thread is a bare "disk I/O error", indistinguishable
from any other write failure. The only ways to set the flag would be matching the
message — the practice pkm-s7af deliberately removed — or estimating from
`navigator.storage.estimate()`, whose numbers are padded. No synthetic
small-quota profile was needed to establish this; the VFS source settles it.

Two further facts made deletion the clear call: the flag's last consumer was
`computeEditability`, whose branch only bit *offline* (`canEdit` is true whenever
connected), and retention no longer depends on it at all (pkm-s7af's one-item
blocklist).

Removed: `quota` from `ReplicaErrorFlags`/`ReplicaError`, from `rpc.ts`'s wire
shape and both ends of the transport, from `workerHandlers`' `ReplicaUnavailableError`
construction, `opQueue`'s `quota` listener set and `onQuota` (interface, both
implementations, the emit site), `SyncProvider`'s `quotaExhausted` state and its
subscription, and `computeEditability`'s third parameter and read-only branch.
Tests updated in `errors.test.ts`, `rpc.test.ts`, `opQueue.replica.test.ts`
(the retention test kept, now driven by a plain `SQLITE_IOERR`) and
`syncState.test.ts`. Each deletion site carries a short note on why the flag
could never be set, so the next person does not rebuild it.

`docs/architecture/sync-and-offline.md`: wire shape corrected to
`{message, rejected, unavailable}`, and a new paragraph records that an
exhausted disk is not distinguishable here and why.

Verified: `pnpm verify` clean (typecheck, lint, FCIS, coverage, build, 51 e2e).

Follow-up filed: **pkm-0htf** — the hazard the dead mechanism was aimed at is
real and broader than quota. A *ready* replica whose writes keep failing raises
no problem and no banner, and its retained lane ops die on a refresh or a closed
tab, since there is no `beforeunload` anywhere in `web/src`.
