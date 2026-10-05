---
# pkm-p5t6
title: 'Perf: a feed window applied over pending batches'
status: todo
type: feature
priority: normal
created_at: 2026-10-05T19:35:27Z
updated_at: 2026-10-05T20:49:55Z
---

The frontend perf scenarios never apply a feed window while optimistic batches are pending, so the replay rebase's per-window cost (rewind of every pending batch's records, op-by-op replay with savepoints, recording afresh) is not measured. Add a perf/check.sh frontend scenario: a replica with a realistic pending queue (several batches: creates, moves, text edits, a delete with a subtree) receiving a few windows, gating on query/VM-work counts like the others. Recommended by the pkm-j3ui final review. Known cost candidates already noted: rewind step 1 re-tokenizes FTS for unchanged text (blocks_fts_au fires whenever text is in the SET list); remapLogPage and dropStrandedLocalPages read replay_log.pre_page_id / replay_log_refs.target_page_id unindexed.


Measure with the scenario (deferred minors from the pkm-j3ui review, confirmed still present 2026-10-05):
- rewind step 1 re-tokenizes FTS for unchanged text (blocks_fts_au fires whenever text is in the UPDATE's SET list);
- replay_log.pre_page_id and replay_log_refs.target_page_id have no index (clientSchema.ts has only idx_replay_log_key and idx_replay_log_refs_log), and remapLogPage / dropStrandedLocalPages read them.
