---
# pkm-x5w0
title: A renamed or merged-away page title comes back via last-write-wins from a stale device
status: completed
type: bug
priority: normal
created_at: 2026-09-03T09:22:53Z
updated_at: 2026-09-03T09:43:07Z
---

Observed 2026-09-02 (pkm-n31j incident): SIS was merged into Student Record System at 22:05:25; at 22:05:33 a second iPad context posted an update_text carrying the old text 'Tags:: #[[SIS]]' for block m8Zi85WyV. Push-time resolution is LWW with the losing text preserved as a [[conflict]] sibling (block y6DXYcOyOpO1 on SITS), and the winning text's [[SIS]] re-created the page (4518), which the user then had to merge again. Working as specified, but any rename/merge while another device holds unsynced edits to a rewritten block will resurrect the old title.

## Decision

Option (a): replay the rename over the stale incoming text instead of letting it win verbatim. Server-side, push-time only; the client's optimistic path does not mirror it, like the rest of the conflict table.

- Rename/merge/title-migration records what it did to each block in a server-only `block_rewrites` table (uid, base_hash, after_hash, old_title, new_title, created_at), pruned at 30 days.
- On an `update_text` carrying a `base_text_hash`, the shell loads that block's records and the pure planner replays them over the incoming text (bounded chain), swapping the op's base hash for the record's `after_hash`, before the existing conflict logic runs unchanged.
- Effect: an edit based on pre-rename text becomes an edit based on post-rename text with the rename applied, so it applies cleanly and the old title's page is not re-created. A block genuinely edited after the rename still takes the LWW + [[conflict]] path, but with the new title in both texts.

## Checklist

- [x] `block_rewrites` in SERVER_DDL (never BASE_DDL; schema-pin test still passes)
- [x] `rewrite_snapshotted_blocks` records one row per changed block per participating title pair, and prunes rows older than 30 days
- [x] pure replay step in `ops_core` (records in as data, bounded loop)
- [x] shell loads records for `op.uid` in `ops_apply._context_for`
- [x] endpoint tests: rename, merge, chained, no-record conflict path, post-rename edit conflict path, pruning
- [x] pure unit test for the replay step
- [x] docs: sync-and-offline conflict table + symptom row, backend write path + server-only tables
- [x] server tests, pyrefly, ruff all pass

## Summary of Changes

`block_rewrites` (SERVER_DDL, index on `(uid, base_hash)`, no journal trigger, absent from BASE_DDL and pinned so by `test_base_ddl_contains_no_server_tables`) records what every rename, merge and title-migration rewrite did to each block: the sha256 of that block's text before and after, plus the one title that moved. `store.rewrite_snapshotted_blocks` writes a row per changed block per title it actually rewrote there, and prunes rows older than 30 days on every call.

`ops_core.replay_title_rewrites` is the pure step. Records arrive as data on `OpContext.block_rewrites`; records sharing a before/after hash pair were one rewrite pass, so they are regrouped into one replacement map (the title migration rewrites several titles at once, and applying them one at a time would not reproduce it). While a step's `base_hash` equals the op's current base hash, the incoming text is rewritten with that map and the base hash becomes the step's `after_hash`. Each step is consumed, and `MAX_REPLAYED_REWRITES` (10) bounds the walk. The existing conflict checks then run unchanged against the replayed text and hash.

Effect: a stale device's edit to a rewritten block applies cleanly under the new title with no `[[conflict]]` sibling, and the old title's page is not re-created. A block edited again after the rename still takes the LWW + `[[conflict]]` path, but both winner and sibling carry the new title.

Not done: the deleted-block branch (`update_text` for a uid whose row is gone, landing on today's daily as `[[conflict]] (original block deleted) …`) does not replay records, so an orphaned stale edit can still re-create the old title's page. Narrower case, left alone deliberately.

Tests: six endpoint tests (rename, merge, chained renames, unmatched hash still conflicts, post-rename edit conflicts under the new title, pruning) and three pure unit tests (chain up to the cap, unmatched/empty records, one multi-title rewrite as a single step). Docs: a conflict-table row and a rewritten symptom row in `sync-and-offline.md`; the write-path note and the server-only-tables entry in `backend.md`.
