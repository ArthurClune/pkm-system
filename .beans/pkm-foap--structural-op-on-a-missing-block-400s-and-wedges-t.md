---
# pkm-foap
title: Structural op on a missing block 400s and wedges the queue
status: completed
type: bug
priority: normal
created_at: 2026-09-28T19:50:15Z
updated_at: 2026-09-28T22:24:05Z
---

A move/set_heading/set_collapsed whose uid the server does not have returns 400 (block not found), which poisons the batch and blocks every later op behind a 'Server rejected a change' banner (seen 2026-09-28 with a move of a never-created block). Consider dropping such ops with a conflict note in the daily note (see the conflicts-in-daily-note spec) instead of rejecting. Needs design.

## Rulings (Arthur, 2026-09-28)

| Op, situation | Server does |
|---|---|
| `set_collapsed` on a missing block | plain no-op (no effects, no note) |
| `delete` on a missing block | plain no-op (no effects, no note) |
| `move` on a missing block | no-op for that op + a daily-note entry saying what was skipped |
| `set_heading` / `set_view_type` on a missing block | no-op + daily-note entry |
| `create` whose parent block does not exist | the block is NOT created; its text lands in today's daily note as a conflict entry (like an edit to a deleted block); rest of batch applies |
| `move` whose target parent does not exist (block exists) | the block stays where it is + a daily-note entry saying the move was skipped and why |

Everything else in the batch applies; the response is 200. Other 400s stay 400.

## Summary of Changes

- `ops_core.classify_missing_target` (pure) sorts an op whose block or
  create/move parent is missing into noop / skipped / orphan_edit /
  diverted_create / move_parent_missing, with the uid its daily-note entry
  groups under (None = nothing lands). `plan_op` and `ops_apply._context_for`
  both call it, so the daily page is resolved only when an entry lands; a
  skipped op resolves no op `page_title` (no page created for an op that
  never applied).
- Entries go through `conflict_entry_effects`: skipped structural ops add
  "move/heading change/view type change skipped: block not found" under the
  `(page unknown)` orphan header for the block's uid; a diverted create lands
  its text under the missing parent's uid with the orphan header labelled
  from the create's page_title (existing-page check); a move to a missing
  parent adds "move skipped: target parent not found" under
  `[[conflict]] [[Page]] — ((uid))`. A blank diverted create lands nothing.
- Unhashed `update_text` on a missing block now lands like a hashed one
  (it wedged the queue the same way and would lose its text; it is the
  normal shape for the fallback lane and same-batch creates).
- New `JournalBlock` effect writes a `changes` row so the feed tombstones
  replica ghosts (created uid + missing parent for a diverted create; the
  uid for skipped/orphan/collapse; the live block + missing parent for a
  move to a missing parent). Nothing journalled for a delete no-op.
- Skipped ops are not broadcast.
- CLI `pkm update` help and `plan_update` docstring no longer promise a
  "block not found" failure; baseTextHash.ts comment updated.
- Tests: ops_core table + planning, ops_apply journal/broadcast, endpoint
  rows end to end, the same-batch chain, replays, feed tombstones; a web
  test that tombstones of unknown uids and of a ghost with a local-only
  child apply cleanly.
- Docs: backend.md write path (missing-targets table, header row, journal
  note), sync-and-offline.md conflict table + convergence paragraph,
  troubleshooting row.
