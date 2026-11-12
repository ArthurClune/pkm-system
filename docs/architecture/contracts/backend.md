# Contract: the backend

The rows a write leaves in the server-only tables, case by case.
`server/tests/props/model.py` is written from this file and never from the
code, and `test_ops_state.py` compares its rows with the database's, so a
change in behaviour edits the row here and the model together. Each
section's principle, and why it holds, is in [backend.md](../backend.md)
under the same section name; a reason that belongs to one row sits in that
row.

## Database

Every `block_rewrites` row carries the rewritten block's `uid`, and
`base_hash` and `after_hash`, the `text_hash` of the block's whole text
before and after the rewrite: one pair for all the rows one rewrite writes.

| Rewrite of a block | Rows | Reason |
|---|---|---|
| a page delete whose unlink changed the block's text, after its copies were inlined | one `unlink` row: `old_title` the page's stored title, `new_title` `''` | a stale edit replays it, so it cannot re-create the page |
| a page delete, the block holding a `((uid))` to a page block | one `inline` row per uid: `old_title` the uid, `new_title` the copied text | a stale edit's `((uid))` to the gone block gets the same copy |
| a page delete, the block doing both | both, under one hash pair | |
| an ops batch's stale unlink or replay | the chain of [contracts/write-path.md § Conflicts](write-path.md#conflicts): an `unlink` row per stale title, then each replayed step's rows | |

| `DELETE /api/page/{title}` | `page_deletions` | Reason |
|---|---|---|
| 200, a page that is no daily note | one row: the page's stored title, and `seq` the journal head after the delete's own journal rows | a batch whose `seen_seq` is below it was made before the delete ([Stale batches](write-path.md#stale-batches)) |
| 200, a daily note | no row | a daily note is re-made on demand, so "stays deleted" cannot hold for it |
| 404 or 409 | no row | nothing was deleted |
