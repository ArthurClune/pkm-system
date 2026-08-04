---
# pkm-avag
title: 'Quota-exhausted read-only mode is unreachable: nothing ever throws quota:true'
status: todo
type: bug
created_at: 2026-08-04T18:18:53Z
updated_at: 2026-08-04T18:18:53Z
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

- [ ] Determine what sqlite-wasm/OPFS raise on a genuinely exhausted quota (may need a synthetic small-quota profile)
- [ ] Decide: wire it up, or delete the chain
- [ ] If wiring: set `quota` where the error originates, and add a test driving the real error shape
- [ ] If deleting: remove the flag from the wire shape, `onQuota`, `quotaExhausted`, and the `computeEditability` branch, plus their tests
- [ ] Update `docs/architecture/sync-and-offline.md` if it describes the read-only path
