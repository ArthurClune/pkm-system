---
# pkm-jowv
title: A reconnect's pull owed behind a pass that fails is dropped, so the reconnect never resyncs
status: in-progress
type: bug
priority: normal
created_at: 2026-11-11T05:04:59Z
updated_at: 2026-11-11T09:11:38Z
parent: pkm-4gda
---

On reconnect the flow asks replicaSync for a pull. If a pass is already running and then fails (the realistic trigger is a fetch hung on the dying connection), the reconnect's owed pull is dropped with it. The completion then decides nothing moved and never bumps resync, so online views miss what other devices wrote during the outage until something else refetches. Reproduced on main before the coalesce conversion and after it. Direction: pull() reports that no pass served it, and the reconnect completion counts that as moved, like its null rule. Needs a red test in reconnectFlow or session tests and a sync property look.

## Todo
- [x] Red test: reconnect owed behind a failing pass, and own pull failing (reconnectFlow.test.ts, real replicaSync)
- [x] start()/pull() report an unserved pull; completion counts it as moved
- [x] Mutation check
- [x] Sync property suite look and proptest run (fails on pre-existing pkm-c6ot)
- [x] Docs: refetch table row
- [ ] Troubleshooting row (own commit)
