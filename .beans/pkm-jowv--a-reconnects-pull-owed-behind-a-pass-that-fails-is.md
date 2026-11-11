---
# pkm-jowv
title: A reconnect's pull owed behind a pass that fails is dropped, so the reconnect never resyncs
status: completed
type: bug
priority: normal
created_at: 2026-11-11T05:04:59Z
updated_at: 2026-11-11T09:11:52Z
parent: pkm-4gda
---

On reconnect the flow asks replicaSync for a pull. If a pass is already running and then fails (the realistic trigger is a fetch hung on the dying connection), the reconnect's owed pull is dropped with it. The completion then decides nothing moved and never bumps resync, so online views miss what other devices wrote during the outage until something else refetches. Reproduced on main before the coalesce conversion and after it. Direction: pull() reports that no pass served it, and the reconnect completion counts that as moved, like its null rule. Needs a red test in reconnectFlow or session tests and a sync property look.

## Todo
- [x] Red test: reconnect owed behind a failing pass, and own pull failing (reconnectFlow.test.ts, real replicaSync)
- [x] start()/pull() report an unserved pull; completion counts it as moved
- [x] Mutation check
- [x] Sync property suite look and proptest run (fails on pre-existing pkm-c6ot)
- [x] Docs: refetch table row
- [x] Troubleshooting row (own commit)

## Summary of Changes

- `replicaSync.start()` (and `pull()` under it) resolves false when no pull pass served the call: its own pass failed, or it was owed behind a pass that failed and so never ran, or there is no usable replica. A failed first initialization still rejects.
- The reconnect completion (`reconnectFlow.ts`) counts an unserved last pull as moved, beside its null rule, so the views refetch; a served trailing pull after an unserved one decides on the versions alone.
- Tests in `reconnectFlow.test.ts` drive the real replicaSync: a reconnect owed behind a failing pass, and a reconnect whose own pull fails, both now resync; a served trailing pull after an unserved one does not.
- Docs: the reconnect row of sync-and-offline.md § When views refetch, one sentence in § The reconnect drain, and a troubleshooting row.
- The sync property suite does not observe resync; its run fails on a pre-existing conflict-noise case filed as pkm-c6ot.
