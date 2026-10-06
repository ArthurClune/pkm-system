---
# pkm-p5t6
title: 'Perf: a feed window applied over pending batches'
status: completed
type: feature
priority: normal
created_at: 2026-10-05T19:35:27Z
updated_at: 2026-10-06T08:03:55Z
---

The frontend perf scenarios never apply a feed window while optimistic batches are pending, so the replay rebase's per-window cost (rewind of every pending batch's records, op-by-op replay with savepoints, recording afresh) is not measured. Add a perf/check.sh frontend scenario: a replica with a realistic pending queue (several batches: creates, moves, text edits, a delete with a subtree) receiving a few windows, gating on query/VM-work counts like the others. Recommended by the pkm-j3ui final review. Known cost candidates already noted: rewind step 1 re-tokenizes FTS for unchanged text (blocks_fts_au fires whenever text is in the SET list); remapLogPage and dropStrandedLocalPages read replay_log.pre_page_id / replay_log_refs.target_page_id unindexed.


Measure with the scenario (deferred minors from the pkm-j3ui review, confirmed still present 2026-10-05):
- rewind step 1 re-tokenizes FTS for unchanged text (blocks_fts_au fires whenever text is in the UPDATE's SET list);
- replay_log.pre_page_id and replay_log_refs.target_page_id have no index (clientSchema.ts has only idx_replay_log_key and idx_replay_log_refs_log), and remapLogPage / dropStrandedLocalPages read them.


## Summary of Changes

- `web/tooling/perf/sqlcount.ts`: counts statements, trigger statements, VM steps (per 1000) and full scans inside a measured call, via sqlite-wasm `sqlite3_trace_v2` / `sqlite3_progress_handler`; full-scan rule ported from `sqlplan.py`.
- `rebaseTargets.ts` + `rebase.perf.ts` + `vitest.rebase.config.ts`: scenario R. Snapshot plus three real windows (edit, paste of 50, overlap) from the fixture server, applied over six pending batches through the worker's `buildHandlers`; two passes must agree. Replica source and sqlite-wasm come from `PERF_WEB_ROOT`, so a merge-base run measures the base's code.
- `check.mjs` letter R (last, Node subprocess), `_CONTEXT_GROUPS` gains "R", `run.py` `check_command` passes `PERF_WEB_ROOT`.
- Baseline bootstrapped from 5 runs at 99d94846: edit 572/912/3911/10, paste 725/1370/3917/10, overlap 564/826/3912/10 (statements/trigger_statements/vm_steps_k/full_scans).

Mutation check: dropping `idx_blocks_parent` after the snapshot moves vm_steps_k 3911→15189 and full_scans 10→14 on every window. (The plan's `idx_replay_log_key` moves nothing: no statement on this path plans through it.)

What it shows: about 96% of each window's VM steps is `replayPending`'s whole-database `PRAGMA foreign_key_check`, run K+1 times per window. The 10 full scans are on small client tables (`pending_ops`, `replay_batches`, and `dropStrandedLocalPages`' `replay_log` / `replay_log_refs` reads). The FTS re-tokenizing candidate shows in trigger_statements.
