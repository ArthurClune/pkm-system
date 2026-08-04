---
# pkm-za9j
title: Latch replica unavailability explicitly in the worker
status: completed
type: task
priority: normal
created_at: 2026-08-04T12:54:38Z
updated_at: 2026-08-04T15:03:22Z
parent: pkm-q2jj
---

buildHandlers latches `unavailable: ReplicaUnavailableError | null` on the first openDb() failure; every handler rejects with it; close() stays the only reset. This REPLACES pkm-bjae's latch, which worked by leaving the memoised dbPromise rejection in place -- correct but implicit, its safety depending on a reader noticing that init() must not clear a promise three modules from where the consequence lands.

Part of epic pkm-q2jj. Design: docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md


## Finding (not fixed here, scope of Task 3): pendingCount lacks a tableExists guard

`workerHandlers.ts:253-255` (`pendingCount` handler) queries `pending_ops`
directly with no schema-existence check:

```ts
async pendingCount() {
  return gate.run(async () => pendingCount(await db()));
},
```

`poisonedBatches` (`workerHandlers.ts:247-251`) guards the same table:

```ts
async poisonedBatches() {
  return gate.run(async () => {
    const d = await db();
    return tableExists(d, "pending_ops") ? poisonedBatches(d) : [];
  });
},
```

On a schemaless database (a genuinely fresh profile, before `init()` has
installed schema) `pendingCount` throws `SQLITE_ERROR: no such table:
pending_ops` instead of resolving 0.

**This is reachable in production**, not just an artifact of a test fixture:
`SyncProvider.tsx:229-231` calls `replicaRef.current?.pendingCount()`
unconditionally in a mount effect ("a durable queue may be non-empty from a
previous session"), independent of and ahead of the effect that calls
`replicaSync.start()` -> `replica.init()` (`SyncProvider.tsx:358`, inside the
`useEffect` starting at line 361). The call is wrapped in
`.catch(() => undefined)`, so today it fails silently with no visible
symptom (the pending count simply never updates from its initial 0) — but it
is exercising the exact no-such-table path on every fresh-profile mount.

Left unfixed deliberately: fixing it would touch a handler outside Task 3's
scope (latching `db()`/`close()`/`init()`'s comment only) and would muddy the
diff Tasks 4-6 build on. Flagging for Arthur/a follow-up bean to decide
whether `pendingCount` should gain the same `tableExists` guard as
`poisonedBatches`.
