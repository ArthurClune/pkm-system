# Contract: the write path

What `POST /api/ops` and `DELETE /api/page/{title}` do, case by case.
`server/tests/props/model.py` is written from this file and never from the
code, so a change in behaviour edits the row here and the model together.
Each section's principle, and why it holds, is in
[write-path.md](../write-path.md) under the same section name; a reason that
belongs to one row sits in that row.

## Planning

### Ordering

| Situation | Outcome |
|---|---|
| an insert or move lands at `order_idx` k | `ShiftSiblings` bumps every sibling (same page, same parent) at or above k by one |
| a move onto its own slot | every later sibling is still bumped, because `ShiftSiblings` cannot tell staying put from moving there |
| gaps left by a delete or a move away | never renumbered |

## Conflicts

A conflict entry lands on the daily page of the batch's `now_ms`. A second
conflict on a block the same day appends under the same header.

| Case | Header text |
|---|---|
| Block exists, hash mismatch | `` [[conflict]] [[Page]] — overwritten by ((uid)) `` |
| Block gone, hint names an existing page | `` [[conflict]] [[Page]] — edit to a block the server no longer has `` |
| Block gone, hint names no current page | `` [[conflict]] `Page` (page not found) — edit to a block the server no longer has `` |
| Block gone, hint missing, blank or [refused](../titles-and-refs.md#refused-titles) | `` [[conflict]] (page unknown) — edit to a block the server no longer has `` |
| Block exists, move target gone or inside it, or a replayed edit over a text limit | `` [[conflict]] [[Page]] — ((uid)) `` |
| Guarded `delete` whose subtree changed | `` [[conflict]] [[Page]] — deleted while edited elsewhere `` |
| Any of these, when the page's name would put the header past a [text limit](#work-bounds-under-the-write-lock) | the name replaced by `(page title too long)` (`LONG_TITLE_LABEL`) |

A page that exists is named by its stored title, never the hint's spelling
(`conflict_notes.existing_page_label`).

`replay_core.classify_text_edit` sorts a hashed `update_text` on a live block,
checking in this order:

| Situation | Outcome |
|---|---|
| `base_text_hash` matches a pre-rewrite snapshot of this block | The `block_rewrites` rows replay over the incoming text (`replay_core.replay`), which then meets the rows below |
| The replay would be over a text limit | The block keeps its text; the edit as sent lands under a conflict header, and the ack lists the op as skipped (`text_limit`) |
| Incoming text equals current | No-op, even with a stale hash |
| `hash(current) == base_text_hash` | Clean apply |
| Hashes differ | Incoming wins; the overwritten text, blank or not, lands under a conflict header |

| Edit | Outcome |
|---|---|
| hashless, to a live block | last-write-wins |
| to a gone block, hashed or not | the text lands under a conflict header ([Missing targets](#missing-targets)) |

The replay covers renames and, through `unlink.apply_delete_rewrite`, page
deletes.

When the written text differs from the sent text (a replay or a stale
unlink), `ops_core.rewrite_effects` records a `block_rewrites` chain
(`RecordRewrite`) from the sent text's hash to the written one. Each
replayed step is recorded whole (`replay_core.rewrite_chain`). The rows a
stale unlink records come from `replay_core.stale_titles_linked`. A row
already stored is not written again (`ops_apply.BatchReplay.recorded`).

| `delete` | Outcome |
|---|---|
| no `base_subtree_hash` | the subtree goes; nothing lands |
| `base_subtree_hash` matches | the subtree goes; nothing lands |
| `base_subtree_hash` differs | the subtree goes, but first every descendant's text, blank ones included, lands under the conflict header, nested, with fresh uids (`ops_core.descendant_copy_effects`) |

`base_subtree_hash` covers the uid and text of the block and every
descendant, not order or nesting (`pkm.contracts.ops.subtree_hash`, with
its web twin in `replica/subtreeHash.ts`).

## Missing targets

`ops_core.classify_skip` sorts an op whose target is gone. Every row is
reported in the ack's `skipped` (`ops_core.skip_report`), with `note_page`
null where nothing landed.

| Op, situation | Outcome | `reason` | Journalled |
|---|---|---|---|
| `set_collapsed` / `delete`, block gone | no-op | `block_not_found` | `set_collapsed`'s uid, since a replica holds a ghost |
| `move` / `set_heading` / `set_view_type`, block gone | child `move skipped: block <uid> not found` (or `heading change` / `view type change`) under `(page unknown)` | `block_not_found` | the uid; a move also its destination siblings |
| `update_text`, block gone | text lands | `block_not_found` | the uid |
| `create`, parent gone | not created; text lands | `parent_not_found` | created uid with its page, and parent uid |
| `move`, parent gone | block stays; `move skipped: target parent <uid> not found` | `parent_not_found` | the parent uid, then the moved subtree |
| top-level `create` into a page deleted since `seen_seq` | not created; text lands under the deleted page's name | `page_deleted` | the created uid |
| top-level `move` onto such a page | block stays; a note naming the page | `page_deleted` | the moved subtree |

- Where a row lands text, a blank text lands nothing. A conflict, by
  contrast, keeps a blank losing text.
- A skipped op resolves no `page_title`.
- A later op in the batch sees a diverted create's block as missing too, and
  a diverted subtree lands flat.
- A skipped `create` or `move` journals its destination siblings where
  nothing else re-ships them (`ops_apply._destination_siblings`).

These are still a 400 for the whole batch:

| Error | Judged by |
|---|---|
| a create's invalid or taken uid; a taken uid outranks a gone parent | `ops_core.plan_op` |
| title syntax in a `create`, `create_page` or `move` `page_title`, or in any ref a text holds; never an `update_text`'s `page_title` | `find_op_title_violation`, before any op applies |
| a skipped op whose own uid, or whose gone parent (a diverted create's, or a move's whose block exists), fails `UID_RE` | `ops_core.impossible_uid_reason` |
| a `create` or `move` that would put a block past `MAX_OUTLINE_DEPTH` | `ops_core._check_depth` ([Work bounds under the write lock](#work-bounds-under-the-write-lock)) |

## Stale batches

A deletion is stale for a batch when its `page_deletions` row has a `seq`
above the batch's `seen_seq` (`store.stale_titles`). A batch without
`seen_seq` has none; one beyond the journal head treats every deletion as
stale. A page re-created after its delete still matches until its row is
pruned.

| Op in a stale batch | Outcome |
|---|---|
| `create_page` for a stale title | dropped, not reported; the replica removes its page (`dropStrandedLocalPages`) |
| top-level `create` / `move` with a stale `page_title` | skipped as `stale_page` (a `SkipKind`), reported `page_deleted` (a `SkipReason`) ([above](#missing-targets)) |
| text linking a stale title | the links become plain text (`replay_core.unlink_stale_text`) |
| a leading `Title::` naming a stale title | fenced in place, `` `X`:: v `` (`unlink.defuse_attribute`), so it indexes no ref; the unlink replay defuses too |
| a link the unlink's passes leave | fenced by `unlink_stale_refs`, its title in backticks inside its brackets (``[[`a[`]]``, `` #`T` ``) |

## Concurrent structure edits

| Op, situation | Outcome | Journalled |
|---|---|---|
| `create` under a live parent on another page than its `page_title` | created on the parent's page | the block |
| `move` under a parent no longer on the page `page_title` names | moved onto the parent's page | the subtree |
| `move` whose target is the block or its descendant | skipped as `move_cycle`, reported `cycle`; child `move skipped: would create a cycle` under the block's header | the moved subtree, root first |

## Page mutations and the sidebar

`unlink.plan_page_delete` decides, before any write:

| Inbound reference | Delete does |
|---|---|
| `[[Title]]`, `#Title`, `#[[Title]]` | becomes plain text |
| `((uid))` to a block of the page | replaced by a copy of that block's text, without its task marker or leading attribute, newlines folded |
| a query macro naming the page | refused: 409 with `blockers` (`DeleteBlockerModel`), `reason` `query`; nothing changes |
| a leading `Title:: v` | refused, `used_as_attribute` |
| the inlined copies would carry the block past a text limit | refused, `limit` |
| unlinking would change the leading attribute name (`[[Title]]:: v`) | refused, `attribute` |
| rewritten text still references the page | refused, `residual` |

`unlink_title_refs` repeats until the text is stable, at most the text's
`[[` depth plus `PASSES_PAST_DEPTH` passes. A link the passes leave makes the
source `residual` (`unlink.unlink_settled`). Rewritten blocks get `unlink`
and `inline` rows and a reindex, and the title goes into `page_deletions`.

## Work bounds under the write lock

| Bound | Constant | Judged in | Past it |
|---|---|---|---|
| a request body | `PRIVATE_BODY_MAX_BYTES` (`auth_gate_core.py`) | `auth_gate_core.private_body_cap`, in `AuthGateMiddleware` | 413 ([request-boundary.md § Auth](../request-boundary.md#auth)) |
| ops in a batch | `MAX_OPS_PER_BATCH` (`contracts/ops.py`) | `OpBatch.ops`, as FastAPI validates the body | 422 |
| a client's block text | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING` (`contracts/ops.py`) | `ops_core.find_op_text_limit_violation` over `text_limits.text_limit_violation`, from `judge_batch` | the whole batch is a 400, unless already applied |
| a page title a `create`, `create_page` or `move` names, or a ref title in a text | `MAX_PAGE_TITLE_CHARS` (`contracts/titles.py`) | `refs.title_length_over`, from `ops_core.find_op_title_violation` in `judge_batch` | as for a block's text |
| where a client's create or move puts a block | `MAX_OUTLINE_DEPTH` (`contracts/ops.py`) | `ops_core._check_depth`, from `plan_op` | the whole batch is a 400 |
| where a conflict entry or a diverged delete's copy lands | `MAX_OUTLINE_DEPTH` | `ops_apply._conflict_landing`, `ops_core.descendant_copy_effects` | never refused; placed no deeper than the cap |
| a conflict header or skip note naming a page | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING` | `conflict_notes._fitted` | the name becomes `LONG_TITLE_LABEL` |
| one replay step | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING`, `MAX_UNLINK_WORK` (`text_limits.py`) | `replay_core._replay_step`, before it splices (`spans.spliced_length`, `text_limits.unlink_refused`); then `classify_text_edit` judges the result | the edit lands `over_limit` |
| a batch's replays | `MAX_BATCH_REPLAY_WORK`, `ROW_CHARS` (`replay_core.py`) | `ops_apply.BatchReplay._spend`, from `BatchReplay._read` and `BatchReplay.charge` | the edit lands `over_limit`; its step spends what is left, so every later step stops before splicing |
| a route's rewrite of stored text: rename, merge, title migration, asset strip | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING` | `text_limits.rewrite_text_limit_violation`, from `store.rewrite_snapshotted_blocks` (`RewriteTextLimitError`) and `routes_assets._strip_references` | refused before any block is written: a rename or merge 422, the migration 409, the strip 409 with `blockers` ([files-and-assets.md](../files-and-assets.md#assets-and-the-file-browser)) |
| a page delete's copies: per page block, per source, and in total | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING`, `MAX_UNLINK_WORK`; the total, `MAX_DELETE_COPY_CHARS` (`unlink.py`) | `unlink._copy_length`, from `unlink.plan_page_delete` in source order | the source is refused, blocker `limit`, on the delete and its preview alike |

The order the judges run in:

1. `judge_batch` judges every op's text, a skipped op's included, then the
   titles.
2. A batch already in `applied_batches` replays its stored ack, whatever
   the judges said.
3. `plan_op` judges a create or move by the level of the deepest block it
   places, with the batch's earlier ops applied. A skipped op is not judged
   for depth.

| Text an op touches | Outcome |
|---|---|
| text the op sends | judged against the limits |
| a stored row over a limit, which a move, `set_*` op or delete touches | goes through: only sent text is judged |
| a server rewrite (`rewrite_text_limit_violation(before, after)`) or unlink (`unlink_refused`) of an over-limit row | allowed at its length or shorter, never longer |
| a move that leaves a legacy subtree past the depth cap | refused |
| an `over_limit` edit | lands as sent, with every title its replay deleted or renamed away made plain (`replay_core.over_limit_landing_text`) |
| a server-made landing at the depth cap | keeps all its text; only the nesting below the cap is lost (`ops_core.descendant_copy_effects`) |

A page delete judges each copy at its projected length before building any
(`unlink._copy_length`, `unlink._Copies`), so it can refuse a delete whose
final text would fit. A projected `limit` is reported ahead of `attribute`
and `residual`.
