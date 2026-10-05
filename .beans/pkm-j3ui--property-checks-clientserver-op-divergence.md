---
# pkm-j3ui
title: 'Property checks: client/server op divergence'
status: completed
type: feature
priority: normal
created_at: 2026-10-02T10:57:25Z
updated_at: 2026-10-05T19:35:41Z
parent: pkm-nws9
---

Random op sequences applied by the server and by the replica (applyLocalOps) and in-memory tree (applyOpInPlace) give the same tree. Cross-language, likely via a generated fixture or the protocol harness. Needs its own brainstorm/spec.

Note from the sync harness (pkm-yxcs): its single-client mode could compare the optimistic replica before a pull with the server after the ack, which checks client/server op divergence for the sync stack's own optimistic apply without a new fixture.

## Progress 2026-10-05

Spec, plan and Tasks 1-6 done on feat/pkm-j3ui-op-divergence. First runs found: A (property, fixed: check S), B/D/E replay != first apply incl. pkm-sj5l proper (→ replay rebase, spec docs/superpowers/specs/2026-10-05-replica-replay-rebase-design.md approved), C (accepted transient, excluded), F (open page loses an off-and-back block: fixed b1e59fd8), G (paste title refusal: tallied). Next: rebase plan. Handover: docs/superpowers/handoffs/2026-10-05-property-checks-handover-4.md


Progress 2026-10-05 (later): replay rebase executed (61fa64c7..10c5a4ad): B, D, E and sj5l fixed, cascade exclusion and rank mode removed, checks 3 and R exact. Teeth (4 mutants caught), calibration (ops NUM_RUNS 2250, ~60 s; web gate ~5 min), docs done. Gates green; final review: merge with fixes (fix wave in progress).

## Summary of Changes

Sub-project 4 of the property-checks epic (pkm-nws9), on feat/pkm-j3ui-op-divergence.

- **Ops property** (web/src/props/ops/): drawn multi-page states and raw-op or outline-command steps run through the server, the replica's optimistic apply and replay, and the in-memory outline tree; checks 1 (echo → tree), 2 (command → server), 3 (optimistic replica → server), R (replay = first apply), S (settled replica = server) and rejection agreement, all on exact keys. Harness echo routes in server/tooling/proptest/sync_server.py. Teeth (ops/teeth.prop.ts, four mutants). NUM_RUNS 2250 (~60 s; web gate ~5 min).
- **Fix F**: needsAuthoritativeReload runs op by op (an open page no longer loses a block a remote batch moves off and back).
- **Replay rebase** (closes pkm-sj5l; fixes findings B, D, E): the effect ledger is replaced by a pre-image replay log (replayLog.ts, rewind.ts); every window rewinds pending batches before the server's rows land, settles acked batches' leftovers at the head after them, then replays each pending batch as a first apply at its enqueue time, op by op. A page's updated_at never steps back on replay. SCHEMA_VERSION changed (one rebuild per device).
- Docs: sync-recovery.md § The replay log, sync-and-offline.md window table, property-checks.md ops section, troubleshooting rows, AGENTS.md budgets.

Follow-ups: pkm-p5t6 (perf scenario for a window over pending batches). Deferred minors (not filed separately): rewind step 1 re-tokenizes FTS for unchanged text; remapLogPage / sweep lookups on replay_log.pre_page_id and replay_log_refs.target_page_id are unindexed; no test isolates the sweep's pre_page_id clause; no rewind test of a step-1 row restored under a step-2 parent; two rewind tests skip ftsIntact(); the enqueue-guard test never creates a legacy effect_ledger alongside; sync_server.py echo state typed as bare dict; as BlockOp casts in tree.test.ts; run.test.ts cosmetics; pruneGraph test gap; replica-delete-cascade spec :24 still says "the ledger".
