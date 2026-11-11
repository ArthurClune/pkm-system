# The write path

This doc follows a write from `POST /api/ops` to its commit and the nudge
after it. It covers the ops a batch carries, the lock every write route takes,
how an op is planned, and what a batch meets when the tree changed after the
client planned it. The routes, the schema, the ref grammar, titles and auth
are in [backend.md](backend.md); how a client queues, pushes and pulls is in
[sync-and-offline.md](sync-and-offline.md). Failures are indexed by symptom in
[troubleshooting.md](../troubleshooting.md).

`POST /api/ops` applies an `OpBatch`. `batch_id` is required (a 422 without
it), because an id-less batch cannot be deduplicated.
`OpBatch.expect`, which only the assistant's approval card sets
([assistant.md](assistant.md#the-write-approval-card)), is checked after the
dedupe read and before any op runs: an entry that no longer holds refuses the
whole batch with 412. Checking after dedupe lets a retried batch that already
applied replay its ack instead of being refused by its own effect.

| Op | Does |
|---|---|
| `create` | insert a block, uncollapsed. `page_title` places a top-level create; a child lands on its parent's page |
| `update_text` | replace a block's text. `page_title` only labels a missing block's conflict header |
| `move` | reposition or reparent; a cross-page move re-pages the subtree. `page_title` places a top-level move |
| `delete` | remove a block and its subtree |
| `set_heading`, `set_view_type`, `set_collapsed` | set a block attribute; collapse is view state only |
| `create_page` | idempotently ensure a page exists |

```mermaid
flowchart LR
    C[Client batch] --> JB["ops_core.judge_batch (Core, threadpool)<br/>text limits, then titles → 400"]
    JB --> R
    subgraph TX["one transaction: BEGIN IMMEDIATE before the dedupe read"]
        R["routes_ops.py (Shell)<br/>idempotency check"] --> E["ops_expect.unmet_expectation (Core)<br/>expect check → 412, nothing written"]
        E --> CTX["ops_apply._context_for (Shell)<br/>read SQLite, classify once → per-kind context"]
        CTX --> P["ops_core.plan_op (Core)<br/>pure: op + context → effect tuples"]
        P --> X["ops_apply._execute (Shell)<br/>effects → SQL"]
    end
    X --> J["change journal<br/>(triggers, plus JournalBlock)"]
    X --> B["WS broadcast + seq nudge<br/>(after commit)"]
```

## The write lock

The routes below take `BEGIN IMMEDIATE` before their first read, so no
concurrent commit lands between that read and the write it justifies. A new
route whose decision rests on what it reads joins them.

**Every one takes the lock through `pkm.server.db.write_txn`.** A lock the
busy timeout could not take is a 503 with `Retry-After`. The helper rolls
back on any raise and commits on a clean exit, a `return` included. The nudge
follows the `with` block ([Post-commit nudges](#post-commit-nudges)).

`test_write_txn.py` scans `server/src` and fails on a `begin_immediate` call
outside the helper, and on a `.commit()` in `pkm/server` outside it.
`upload_asset` alone is allow-listed: `assets` is not journalled, so it
skips `write_txn` (no `BEGIN IMMEDIATE`) and has no busy branch. Its `INSERT`
takes the lock implicitly, and a lock held past `BUSY_TIMEOUT_MS` reaches the
client as a 500. The route is `async`, so that wait also blocks the event
loop. Only a threadpool route can be the holder, since `post_ops` never yields
the loop while it holds the lock.

A read of several statements, such as a sync payload or the assistant's
card, takes one snapshot through `db.read_txn`, without the write lock. A
write committed between its statements then cannot reach half of the
payload. The same test file fails on a bare `BEGIN` in `pkm/server` or
`pkm/assistant` outside `db.py`, and on a write, commit or rollback inside a
`with read_txn` body.

| Route | Lock taken before |
|---|---|
| `POST /api/ops` | the dedupe read and every op's context read; the text and title judges run before it, in the threadpool |
| `POST /api/page/{title}/rename` | the snapshot of referencing blocks, so no batch commits an unrewritten `[[Old]]`; a title race cannot reach the `UPDATE` |
| `DELETE /api/page/{title}` | the snapshot of referencing blocks |
| `DELETE /api/assets/{sha256}` | the strip's read of each referencing block, or with `if_unreferenced=true` the reference check |
| `POST /api/journal/cleanup` | the emptiness and link checks, so a block created on the day cannot go with the page |
| `POST /api/sidebar` | the uniqueness check and `max(order_idx) + 1`, so a same-title race is a 409 |
| `PUT /api/sidebar` | the read of `existing_ids` the order is validated against, so an entry added or removed meanwhile cannot slip past the check |
| `DELETE /api/sidebar/{entry_id}`, `POST /api/pages` | the write itself |
| `GET /api/page/{title}` and `GET /api/journal` | on the miss path only: a read of today's page runs unlocked, and a miss takes the lock and reads again before creating |
| `POST /api/migrations/title-canonicalization` | the re-inventory |

A lock holder must never await the event loop before its commit. Another
request on the loop would wait in `BEGIN IMMEDIATE` for the busy timeout,
blocking the loop, while the holder cannot resume to commit; every write
would stall and then 503. The same scan fails on an `await` inside a
`with write_txn` body, and on a `commit` or `rollback` there, which the
helper owns.

`apply_batch` holds the lock on the event loop;
[Work bounds under the write lock](#work-bounds-under-the-write-lock)
states what bounds its work.

## Planning

Planning here is `ops_core.plan_op`: one op and its context in, effect
tuples out. `ops_apply._context_for` classifies each op once (`classify_skip`,
and `replay_core.classify_text_edit` for a hashed edit) and hands `plan_op`
the context type that classification calls for, such as
`TextConflictContext` or `StuckMoveContext`. `apply_batch` reads the ack's
skip off the same context. No context field has a default. A hashed
edit's context carries the whole `TextEditOutcome`, which `plan_op` plans
from and `apply_batch` charges. A context that does not fit its op, or an
outcome that does not fit its context, is an `AssertionError`. That is a
500 the client retries; it must never be a 400, which would poison the
client's queue over a server bug.

- **Ordering.** An insert or move emits `ShiftSiblings`, bumping every
  sibling at or above the target `order_idx`. Nothing renumbers the gaps this
  leaves. A move onto its own slot still bumps every later sibling, because
  `ShiftSiblings` cannot tell staying put from moving there.
- **Refs.** Every text change emits `ReindexRefs`, whose only implementation
  is `store.reindex_refs_for_text`; the rename rewrite and the asset-token
  strip call it too. It never commits. `importer/migrate_mermaid_blocks.py`
  skips it. The schema's
  triggers keep `blocks_fts` and `changes` current but never `refs`, so a
  direct SQL `UPDATE blocks SET text` that adds or changes a link leaves
  backlinks stale. Edit linking text through the ops path (`pkm batch`).
- **Timestamps.** `blocks.updated_at` means last really changed, so
  `set_collapsed` stamps neither block nor page; the journal still carries
  the collapse.
- **Idempotency.** A retried `batch_id` with a matching hash replays the
  stored ack with no effects; with other ops it is a 409. The stored
  `batch_replay_hash` (`ops_hash.py`) leaves out `base_text_hash`,
  `update_text`'s `page_title` and `base_subtree_hash`, which the worker may
  fill into only the durable copy of a batch. A change to what either hash
  covers re-hashes every stored batch of that kind, and a retry across the
  deploy then 409s. `op_hashes.json` pins both hashes for every op kind,
  and a new optional field must be left out of the hash while unset.
- **Well-formed text.** `WellFormedModel` turns lone surrogates into U+FFFD
  ([Hostile input](backend.md#hostile-input)). The rule is to normalise, never reject:
  SQLite cannot bind a surrogate, a 5xx is retried forever and a 4xx poisons
  the batch. `text_hash` hashes the well-formed form, as the web does.
- **Text limits.** `ops_core.judge_batch` judges every op's text against
  the [text limits](#work-bounds-under-the-write-lock), a skipped one
  included, before the title check, so `extract` never scans an over-long
  text. Length is judged before nesting, so the nesting measure never reads
  past the cap. The route runs it in the threadpool before `BEGIN
  IMMEDIATE`: judging a large batch takes seconds, and the judges must hold
  neither the single writer nor the event loop. `apply_batch` takes a
  `JudgedBatch`, and only `judge_batch` makes one. That is a convention, not
  a check: the dataclass is public. A refused batch is looked up in
  `applied_batches` without the lock before its 400, and one already applied
  replays its stored ack. A deploy that tightens a limit can therefore never
  turn the retry of a batch whose ack was lost into a 400, which the client
  treats as terminal and discards. A client's text is refused whole, and
  server-made text never is
  ([Work bounds](#work-bounds-under-the-write-lock)).
- **Title reader.** `apply_batch` reads the title flag once
  (`title_reader`) and passes that one reader to every title the batch
  resolves, every replay and every landing. The replay must match titles
  as the rename or delete it replays did: under plain-space
  canonicalisation a `[[ Old ]]` the client added offline is the page
  `Old`, and left linked it re-creates it. A step derives its canonical
  titles once per batch, so asking it under a second reader is an
  `AssertionError` (`replay_core._derived`).

## Conflicts

Conflicts, missing targets, stale batches and concurrent structure edits are
what a batch meets when the tree changed after it was planned. None rejects
the batch.

`update_text` may carry `base_text_hash`, the sha256 of the text it was based
on; a hash, unlike a version counter, ignores structural change. On a
mismatch, or an edit to a gone block, the incoming edit wins and the losing
text, blank or not, lands under a `[[conflict]]` header on the daily page of
the batch's `now_ms`. The batch reads the clock once; `_conflict_landing`
never reads it. A second conflict on a block the same day appends under the
same header.

| Case | Header text |
|---|---|
| Block exists, hash mismatch | `` [[conflict]] [[Page]] — overwritten by ((uid)) `` |
| Block gone, hint names an existing page | `` [[conflict]] [[Page]] — edit to a block the server no longer has `` |
| Block gone, hint names no current page | `` [[conflict]] `Page` (page not found) — edit to a block the server no longer has `` |
| Block gone, hint missing, blank or [refused](backend.md#refused-titles) | `` [[conflict]] (page unknown) — edit to a block the server no longer has `` |
| Block exists, move target gone or inside it, or a replayed edit over a text limit | `` [[conflict]] [[Page]] — ((uid)) `` |
| Guarded `delete` whose subtree changed | `` [[conflict]] [[Page]] — deleted while edited elsewhere `` |
| Any of these, when the page's name would put the header past a [text limit](#work-bounds-under-the-write-lock) | the name replaced by `(page title too long)` (`LONG_TITLE_LABEL`) |

The `page_title` hint never changes whether or where an op applies, and
`find_op_title_violation` never reads it. A hint naming no current page is
inline code, which the ref extractor skips, so the header cannot re-create
the page (`ops_apply._hint_page`). An existing page is linked by its stored
title, only when `[[Page]]` reads back as it
(`conflict_notes.existing_page_label`). `contracts.ops.new_uid` starts uids
with an alphanumeric so the CLI can address them without `--`.

`replay_core.classify_text_edit` sorts a hashed `update_text` on a live block,
checking in this order:

| Situation | Outcome |
|---|---|
| `base_text_hash` matches a pre-rewrite snapshot of this block | The `block_rewrites` rows replay over the incoming text (`replay_core.replay`), which then meets the rows below |
| The replay would be over a text limit | The block keeps its text; the edit as sent lands under a conflict header, and the ack lists the op as skipped (`text_limit`) |
| Incoming text equals current | No-op, even with a stale hash |
| `hash(current) == base_text_hash` | Clean apply |
| Hashes differ | Incoming wins; the overwritten text lands under a conflict header |

The replay covers renames and, through `unlink.apply_delete_rewrite`, page
deletes. So a stale edit cannot re-create a renamed-away page, a link to a
deleted page, or a `((ref))` to a gone block. A hashless edit to a live block
is last-write-wins. A replay or stale unlink makes the written text differ
from the sent text, and the client hashes its next edit from what it sent.
So `ops_core.rewrite_effects` plans a `block_rewrites` chain
(`RecordRewrite`) from the sent text's hash to the written one.

The chain's stale-unlink rows name each stale title whose own unlink would
change the sent text, and never one that only another title's unlink
exposes. `replay_core.stale_titles_linked` finds them in one pass over the
text's titles, not over the titles deleted since `seen_seq`, whose number the
client picks (`test_naming_the_stale_titles_walks_the_text_not_the_deletions`).

A replayed step is recorded whole (`replay_core._step_records`): every
title, rename and copy it holds, not only what the sent text moved. The
client's next queued edit is hashed on the sent text and replays these
rows, so a ref it adds back still gets its copy, and a link it adds back is
still unlinked in a batch without `seen_seq`. Recording is
[charged](#work-bounds-under-the-write-lock). A row identical to one already
stored under its base hash is not written again
(`ops_apply.BatchReplay.recorded`), or one stale edit posted again would
multiply its rows. Under a hash too costly to read for that comparison every
row is written, since a row a later edit needs must never be dropped.

`delete` may carry `base_subtree_hash` over the uid and text of the block
and every descendant ([canonical form](sync-and-offline.md#conflicts-at-push-time)).
Order and nesting are not hashed, so a reorder does not diverge it. On a
mismatch the delete still wins, but first every descendant's text, blank
ones included, lands under the conflict header, nested, with fresh uids
(`ops_core.descendant_copy_effects`). The header is never inside the subtree
being deleted (`_conflict_landing`'s `exclude`).

## Missing targets

An op whose block, or create or move parent, is gone never rejects its
batch: a batch is atomic, so one such op would take every valid op down with
a 400 and wedge the client's queue. `ops_core.classify_skip` sorts it before
its context is read. Each entry is grouped under the block's uid (a diverted
create's under its parent's), and every row is reported in the ack's
`skipped` (`ops_core.skip_report`), with `note_page` null where nothing
landed.

| Op, situation | Outcome | `reason` | Journalled |
|---|---|---|---|
| `set_collapsed` / `delete`, block gone | no-op | `block_not_found` | `set_collapsed`'s uid, since a replica holds a ghost |
| `move` / `set_heading` / `set_view_type`, block gone | child `move skipped: block <uid> not found` (or `heading change` / `view type change`) under `(page unknown)` | `block_not_found` | the uid; a move also its destination siblings |
| `update_text`, block gone | text lands | `block_not_found` | the uid |
| `create`, parent gone | not created; text lands | `parent_not_found` | created uid with its page, and parent uid |
| `move`, parent gone | block stays; `move skipped: target parent <uid> not found` | `parent_not_found` | the parent uid, then the moved subtree |
| top-level `create` into a page deleted since `seen_seq` | not created; text lands under the deleted page's name | `page_deleted` | the created uid |
| top-level `move` onto such a page | block stays; a note naming the page | `page_deleted` | the moved subtree |

Where a row lands text, a blank text lands nothing; a conflict, by contrast,
keeps a blank losing text. A skipped op resolves no `page_title`, which
would create a page for an op that never applied. A later op in the batch
sees a diverted create's block as missing too, and a diverted subtree lands
flat.

`JournalBlock` writes the row a trigger would, straight into `changes`, so
FTS and refs stay untouched. It marks a uid with no block row `deleted`,
because the feed ships a block tombstone only from a delete row. A move to a
missing parent journals the whole moved subtree: the ghost parent's
tombstone cascades the blocks a replica moved under it, and these rows
restore them.

A skipped `create` or `move` shifted its destination siblings in the
client's optimistic apply but not on the server. Where nothing else re-ships
them, `ops_apply._destination_siblings` journals them. The replica's
[replay log](sync-and-offline.md#the-replay-log) does not rely on these rows.

| Skip | Destination | Siblings journalled |
|---|---|---|
| move of a gone block | a live `parent_uid` | its children |
| move of a gone block | top level, `page_title` naming a page | that page's top-level blocks (never created) |
| move of a gone block | top level, no `page_title` | the top level of the page on its latest tombstone with a `changes.page_id` |
| any | a gone `parent_uid` | none: the parent's tombstone cascades them |
| `move_cycle` | the target's children | none: they lie inside the journalled subtree |

A block the server never created has no delete row, so a diverted create
writes its page onto its own tombstone (`ops_apply._diverted_create_page`):
the page its `page_title` names if one exists, else the page on the parent's
tombstone.

Other planning errors stay 400s: an invalid or taken uid, title syntax.
`find_op_title_violation` checks every `page_title` of a `create`,
`create_page` or `move` and every ref title in block text before any op
applies. A skipped op whose own uid fails `UID_RE` is still a 400
(`ops_core.impossible_uid_reason`), which keeps arbitrary strings out of the
journal. So is the gone parent of a diverted create or of a move whose block
exists. A move of a gone block never checks its parent uid. A taken uid outranks a gone parent.

A `create` or `move` that would put a block past `MAX_OUTLINE_DEPTH` is a
400 as well. Server-made landings are never refused for depth, and never
land past the cap;
[Work bounds under the write lock](#work-bounds-under-the-write-lock) gives
the rule and its reason.

## Stale batches

An offline device that never pulled a page delete still holds edits against
the page. `apply_batch` asks `store.stale_titles` for `page_deletions` titles
with a `seq` above the batch's `seen_seq`; a batch without `seen_seq` pays no
query, and one beyond the journal head (a replaced database) treats every
deletion as newer.

| Op in a stale batch | Outcome |
|---|---|
| `create_page` for a stale title | dropped, not reported; the replica removes its page (`dropStrandedLocalPages`) |
| top-level `create` / `move` with a stale `page_title` | skipped as `stale_page` (a `SkipKind`), reported `page_deleted` (a `SkipReason`) ([above](#missing-targets)) |
| text linking a stale title | the links become plain text (`replay_core.unlink_stale_text`) |
| a leading `Title::` naming a stale title | fenced in place, `` `X`:: v `` (`unlink.defuse_attribute`), so it indexes no ref; the unlink replay defuses too. The backticks can carry a text at the cap past it ([Work bounds under the write lock](#work-bounds-under-the-write-lock)) |

`unlink_stale_refs` fences what the unlink's passes leave: the title goes
in backticks inside its brackets (``[[`a[`]]``, `` #`T` ``). A run whose
title holds a backtick is no run, so the link is gone whatever the
backticks pair with, and nothing the user wrote is removed. Only a legacy
title ending in `[`, or a code span that moves as links go, leaves one.

A page re-created after its delete still matches until its row is pruned.

## Concurrent structure edits

| Op, situation | Outcome | Journalled |
|---|---|---|
| `create` under a live parent on another page than its `page_title` | created on the parent's page | the block |
| `move` under a parent no longer on the page `page_title` names | moved onto the parent's page | the subtree |
| `move` whose target is the block or its descendant | skipped as `move_cycle`, reported `cycle`; child `move skipped: would create a cycle` under the block's header | the moved subtree, root first |

`_context_for` resolves `page_title` only for a top-level create or move, so
a stale title never creates an empty page. The cycle skip journals no
tombstone, since nothing is gone. Its journalled subtree carries what the
replica's optimistic move touched: re-paged descendants and the target's
shifted children.

## Page mutations and the sidebar

`store.py` page mutations never commit; routes own the transaction. Rename
rewrites every referencing block through `rename.py` and, with `allow_merge`,
merges by concatenating blocks. `DELETE /api/page/{title}` runs
`store.delete_page_unlinking`, which plans with `unlink.plan_page_delete`
before any write:

| Inbound reference | Delete does |
|---|---|
| `[[Title]]`, `#Title`, `#[[Title]]` | becomes plain text |
| `((uid))` to a block of the page | replaced by a copy of that block's text, without its task marker or leading attribute, newlines folded |
| a query macro naming the page | refused: 409 with `blockers`, `reason` `query`; nothing changes |
| a leading `Title:: v` | refused, `used_as_attribute`: the block's next edit would recreate the page |
| the inlined copies would carry the block past a text limit | refused, `limit` |
| unlinking would change the leading attribute name (`[[Title]]:: v`) | refused, `attribute` |
| rewritten text still references the page | refused, `residual` |

`unlink_title_refs` repeats until the text is stable, because a nested legacy
link loses one layer per pass. It stops after the text's `[[` depth plus
two passes that change it (`unlink.unlink_settled`): the depth peels nested
links, and the two cover a tag an unlink exposes (`##[[T]]`,
`[[\n#T\n]]#T`). A title ending in `[` (legacy only), or a code span that
moves as links go, can need more. A delete then finds the link the passes
left and reports the source `residual`. A link's alias label is found by
looking back to the last `[` only (`unlink._alias_label`). Rewritten
blocks get `unlink` and `inline` rows and a reindex, and the title goes into `page_deletions`. The replay of
an `unlink` row matches titles through the same `title_reader`, or a stale
padded `[[ Title ]]` would survive and recreate the page.

A rewrite the server makes of stored text can grow it: a longer title per
link, a copy per `((uid))`, a stripped asset token that joins `[` to `[`.
[Work bounds under the write lock](#work-bounds-under-the-write-lock)
states how each path bounds it, and each refusal.

A blocker carries `excerpt`, the block's first `BLOCKER_EXCERPT_CHARS` code
points, and `text_length` in code points, never the whole text
(`DeleteBlockerModel.of`). A reader shows a cut excerpt as cut: the web's
`blockerExcerpt` appends `… (N characters)`.

`cleanup_journal` spares any daily note with an incoming link, so a link to a
journal day cannot dangle. `POST /api/sidebar` is its own path under the
[write lock](#the-write-lock).

## Work bounds under the write lock

`apply_batch` runs on the event loop and holds the write lock until the
commit, so its work stalls every other request. Its work is a constant, plus
work linear in the request, plus work linear in the rows and subtrees of the
blocks the batch touches. What it derives from the server's history rather
than from the request is charged to the batch's replay budget. The routes
that rewrite stored text judge each block they rewrite, and a page delete
also bounds the copies it builds.

| Bound | Constant | Judged in | Past it |
|---|---|---|---|
| a request body | `PRIVATE_BODY_MAX_BYTES` (`auth_gate_core.py`) | `auth_gate_core.private_body_cap`, applied by `AuthGateMiddleware` before the app reads the body | 413 ([backend.md § Auth](backend.md#auth)) |
| ops in a batch | `MAX_OPS_PER_BATCH` (`contracts/ops.py`) | `OpBatch.ops`, as FastAPI validates the body | 422 |
| a client's block text | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING` (`contracts/ops.py`) | `ops_core.find_op_text_limit_violation` over `text_limits.text_limit_violation`, from `judge_batch` ([Planning](#planning), Text limits) | the whole batch is a 400, unless `applied_batches` holds it, which replays its ack |
| a page title a `create`, `create_page` or `move` names, or a ref title in a text | `MAX_PAGE_TITLE_CHARS` (`contracts/titles.py`) | `refs.title_length_over`, from `ops_core.find_op_title_violation` in `judge_batch` | as for a block's text |
| where a client's create or move puts a block | `MAX_OUTLINE_DEPTH` (`contracts/ops.py`) | `ops_core._check_depth`, from `plan_op` | the whole batch is a 400 |
| where a conflict entry or a diverged delete's copy lands | `MAX_OUTLINE_DEPTH` | `ops_apply._conflict_landing`, `ops_core.descendant_copy_effects` | never refused. `_conflict_landing` reuses today's header only while its level is below the cap, else opens a fresh top-level one; `descendant_copy_effects` lands every copy below the cap at it, in document order |
| a conflict header or skip note naming a page | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING` | `conflict_notes._fitted` | the name becomes `LONG_TITLE_LABEL`. The rest stays, so a hint naming no page still says `(page not found)` |
| one replay step | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING`, `MAX_UNLINK_WORK` (`text_limits.py`) | `replay_core._replay_step`, from the spans before it splices (`spans.spliced_length`, `text_limits.unlink_refused`); then `classify_text_edit` judges the result with `text_limit_violation` | the edit lands `over_limit` |
| a batch's replays | `MAX_BATCH_REPLAY_WORK`, `ROW_CHARS` (`replay_core.py`) | `ops_apply.BatchReplay._spend`, from `BatchReplay._read` and `BatchReplay.charge` | the edit lands `over_limit`, and its step spends what is left, so every later step of the batch stops before splicing |
| a route's rewrite of stored text: rename, merge, title migration, asset strip | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING` | `text_limits.rewrite_text_limit_violation`, from `store.rewrite_snapshotted_blocks` (`RewriteTextLimitError`) and `routes_assets._strip_references` | before any block is written: 422 for a rename or merge, 409 for the migration, 409 `{message, blockers}` for the strip, each blocker `limit` ([files-and-assets.md](files-and-assets.md#assets-and-the-file-browser)) |
| a page delete's copies: one page block, a source with its copies in, the total over all sources | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING`, `MAX_UNLINK_WORK`; the total, `MAX_DELETE_COPY_CHARS` (`unlink.py`) | `unlink._Copies.projected` and `unlink._Copies.get`, then `unlink._copy_length` and `unlink.plan_page_delete`, in source order | each source that would pass a bound is refused, blocker `limit`, on the delete and its preview alike |

The text limits exist because export holds a whole block in memory and the
web tokenizer recurses once per nested run. The depth cap exists because the
page, block and journal reads answer 500 on an outline 255 levels deep:
pydantic-core's serialiser has a fixed recursion guard, so one bound on
writes protects every reader.

A 400 is only ever over what the client sent. A client's own text, titles and
placements are refused whole. Text and placement the server makes are never
refused, because a 400 makes the client discard its whole offline batch over
something it did not send. That covers a replay, a stale unlink, a conflict
header and a diverged delete's copies.

Server-made text passes a limit only by backticks. A header or note is
`_fitted`, and text the planner copies from a stored row is level with that
row. An unlink only shortens text, bar two additions: `unlink.defuse_attribute`
fences a leading attribute that names a deleted page, and
`unlink.unlink_stale_refs` fences each link the unlink's passes leave
([Stale batches](#stale-batches)). Each fence adds two backticks. A text at
the cap whose leading attribute names a deleted page is stored at
`MAX_BLOCK_TEXT_CHARS` + 2
(`test_a_stale_defuse_at_the_cap_stores_at_most_two_more`).

A stored row over a limit may stay level or improve, never get worse. Only
the text an op sends is judged: a move, `set_*` op or delete of such a row
goes through, and an edit that brings it under is accepted. A server rewrite
asks `rewrite_text_limit_violation(before, after)`, which refuses `after`
only when it is over the length cap and longer than `before`, or nested past
the cap and deeper than `before`. `unlink_refused` allows level on both its
rules too, so the page a legacy row links stays renamable and deletable.
Depth is stricter: a move is judged by where it puts blocks, so one that
leaves a legacy subtree past the cap is refused.

An `over_limit` edit leaves the block's text as it was, lands as a conflict
entry, and is listed in the ack's `skipped` as `text_limit`. The entry is the
edit as sent, with every title the replay's chain deleted or renamed away,
including those past the step that stopped it, made plain
(`replay_core.over_limit_landing_text`); left linked, it would re-create
those pages. A step is judged from its spans before it splices, because a
title may be `MAX_PAGE_TITLE_CHARS` long, a legacy one longer, and each link
grows by up to the title's growth.

The replay budget is counted in characters. A block can hold millions of
rows, so without it a batch of tiny edits could hold the write lock for
minutes. It charges, and leaves uncharged:

| Work | Charge |
|---|---|
| reading the rows from one base hash (`ops_apply._rewrites_within`) | each row's old and new text in bytes, plus `ROW_CHARS`, measured with `octet_length` through `idx_block_rewrites_uid` before any text loads (`test_the_charge_sizes_rows_without_reading_their_text`) |
| an unlink | what the capped unlink can read (`unlink.unlink_reads`) |
| a rename | the text it scans plus the text it splices, since a longer title grows every link |
| the [rows](#conflicts) an op records for a step that changed its text (`replay_core._charged`) | each row's old and new text, plus `ROW_CHARS`; an inline row's new text is its copy |
| a move or delete of a large subtree, which rewrites or hashes every descendant | nothing |
| the stale-title load (`store.stale_titles`), once per batch | nothing; it is linear in the pages deleted since the batch's `seen_seq`, which the client sends |

The uncharged costs grow with the server's data, not the request. A
request bounds only how many such ops it carries, so a batch can repeat
them; [SECURITY.md § Known limitations](../SECURITY.md#known-limitations)
states the consequence.

A step a cap or the budget stops pays for what it scanned or built
(`replay_core._spent`), or every later op of the batch would repeat it.
Nothing an op does beyond its charge may grow with the block's rows or a
step's titles, so a block's rows are read one base hash at a time, only when
an edit's walk reaches that hash (`BatchReplay.walk`). A hash too costly to
read stops the walk blind: the edit lands as sent, with every link made
plain, since any could name a page the unread chain deleted. The rewrite rows
look up the classification's steps by `replay_core._step_key` instead of
replaying them (`test_an_edit_pays_for_its_replay_once`).

A page delete judges a copy's projected length (`spans.spliced_length` of
the refs it holds) before building it, and builds a page block's copy only
when a source refers to it (`unlink._Copies`), projecting each block once
(`test_many_referrers_to_one_ref_heavy_block_cost_one_projection`). A copy
that blanks down to `""` still costs that length to build. Copies
that each nest within the cap can join into one deep link, and the unlink
peels one layer per pass, so the spliced text is judged before unlinking
(`test_copies_joined_into_one_deep_link_are_refused_before_unlinking`). A
source refused for its depth keeps its copy text counted against
`MAX_DELETE_COPY_CHARS`, since its copies were built. A source is judged
before unlinking, and the passes can remove any amount of text, so a delete
whose final text would fit can still be refused: `MAX_DELETE_COPY_CHARS`
trades such a delete for a bound on the work. A projected `limit` comes ahead
of `attribute` and `residual`, so the delete dialog names the length first.

`plan_op` judges a create by its own level and a move by the level its
subtree's deepest block lands at; a top-level block is level 1. Each op
sees the batch's earlier ops applied. A skipped op places none of the
client's blocks, so it is not judged.

**Depth rejects the batch rather than skipping the op like `move_cycle`.**
A skip would need its own note, journal rows and replica mirror, for a case
that needs an outline near the cap, far deeper than any in use. The cost,
accepted in the [design](../superpowers/specs/2026-10-24-outline-depth-cap-design.md),
is a web offline batch
[discarded](sync-recovery.md#a-batch-the-server-rejects) when two devices'
edits, each legal alone, stack past the cap. The web refuses what it can see
first ([frontend-editor.md](frontend-editor.md#rules-an-edit-must-not-break)).

Server-made landings are bounded instead. Left unbounded, they stack: a
diverged delete of a top-level block copies its subtree one level deeper,
under a new header, and a client may send any `base_subtree_hash`.
Deleting each new header in turn then adds a level per batch. At the cap
no text is lost, only nesting below it. A client can move an emptied
header to the cap; only a legacy row sits deeper.

## Post-commit nudges

**Every route whose commit touches a journalled table (`blocks`, `pages`,
`sidebar_entries`) sends a WS `{type:"seq", seq}` nudge right after that
commit.** `seq` is the real journal maximum. A metadata or generation change
that may not advance `changes.seq` adds `force:true` and the new
`generation`, which makes a client pull at its own cursor without advancing
it. `POST /api/ops` also echoes the applied ops.

A route under [`write_txn`](#the-write-lock) nudges after its `with` block:
`notify.nudge_threadpool` from a sync-def route, `await nudge(request, db)`
from `post_ops`. There is no other way to commit and nudge. `delete_asset` nudges because
it rewrites blocks; `cleanup_journal` only when it deleted something. No type
or test discovers a new route: `test_journal_advancing_contract.py` asserts
the nudge for each route on its hand-kept list, so a new journal-advancing
route adds its own case there.

```mermaid
flowchart LR
    B["Hub.broadcast()"] --> Q["per-client queue<br/>(QUEUE_SIZE)"]
    Q --> D["drain task,<br/>one per connection"]
    D -->|"send_json under SEND_TIMEOUT"| C([client])
    Q -.->|"queue full, or send times out"| X([disconnect and close])
```

`Hub.broadcast()` (`ws.py`) never awaits a send, so a stalled client blocks
neither the write path nor other clients. Each connection's `_drain` task is
the sole consumer of its `asyncio.Queue`, and `broadcast()`'s loop has no
`await`, so a client receives frames in `broadcast()` call order; a second
consumer or another queue would break that silently. Dropping a client at
`QUEUE_SIZE` or `SEND_TIMEOUT` closes the socket (`_safe_close`), because
otherwise `onclose` never fires and the client never resyncs.
