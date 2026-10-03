---
# pkm-yxcs
title: 'Property checks: sync protocol harness'
status: completed
type: feature
priority: normal
created_at: 2026-10-02T10:57:25Z
updated_at: 2026-10-03T17:47:20Z
parent: pkm-nws9
---

fast-check model-based test driving the real web sync stack (op queue, replica, recovery) against a real server with fault injection: offline edits, lost acks, duplicate delivery, reloads, multiple clients. Converge with nothing lost or applied twice. Needs its own brainstorm/spec.


## Summary of Changes
`proptest/check.sh web` runs a fast-check model-based suite that drives the real web sync stack (sqlite-wasm replica, worker handlers, op queue, replicaSync, clientRuntime, reconnectFlow) for 2–3 clients against a real server (test-only `sync_server.py` on 8978) with transport faults (offline, dropAck, duplicate, lostPull, writeFails), reloads, nudges, generation rotation, bad batches and midnight crossings. The oracle checks convergence, accounting, per-client order, no unexplained desync/poison, a fault-free serial replay and cursor monotonicity; teeth tests prove each check catches a broken transport. Product seams: `createOpQueue(replica, deps?)` and `clientRuntime.ts` extracted from SyncProvider. Calibrated at NUM_RUNS 3200 (~3 min; per-suite budget). The suite found six product failures (F1, F2, F4, F6, F7, F8) under five beans, all fixed here: pkm-f170, pkm-hz8w, pkm-hb4x, pkm-undg, pkm-pp7q, plus harness bugs F3, F5, F9. Open follow-ups: pkm-d3qh, pkm-dbr1, pkm-sj5l, pkm-y0kq, pkm-91ux, pkm-5k8q. Docs: property-checks.md (web side), sync-and-offline.md, sync-recovery.md, backend.md, frontend.md, troubleshooting.md, AGENTS.md (port 8978, per-suite budget).
