# The write path

This doc follows a write from `POST /api/ops` to its commit and the nudge
after it. It covers the ops a batch carries, the lock every write route takes,
how an op is planned, and what a batch meets when the tree changed after the
client planned it. The routes, the schema, the ref grammar, titles and auth
are in [backend.md](backend.md); how a client queues, pushes and pulls is in
[sync-and-offline.md](sync-and-offline.md).

`POST /api/ops` applies an `OpBatch`. `OpBatch.expect`, which only the
assistant's approval card sets
([assistant.md](assistant.md#the-write-approval-card)), is checked after the
dedupe read and before any op runs. An entry that no longer holds refuses the
whole batch with 412. The dedupe comes first so that a retried batch that
already applied replays its ack, instead of failing a check its own apply made
false.

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
busy timeout could not take is a 503 with `Retry-After`, and the nudge
follows the `with` block ([Post-commit nudges](#post-commit-nudges)).

A lock holder must never await the event loop before its commit. Another
request on the loop would wait in `BEGIN IMMEDIATE` for the busy timeout,
blocking the loop, while the holder cannot resume to commit; every write
would stall and then 503.

`test_write_txn.py` enforces both rules. It allow-lists only `upload_asset`:
`assets` is not journalled, so the route skips `write_txn` and has no busy
branch. Its `INSERT` takes the lock implicitly, so a lock held past
`BUSY_TIMEOUT_MS` reaches the upload as a 500, and the `async` route blocks
the event loop while it waits. The holder can only be a threadpool route,
because `post_ops` never yields the loop while it holds the lock.

A read of several statements, such as a sync payload or the assistant's
card, takes one snapshot through `db.read_txn`, without the write lock, so
a write committed between its statements cannot reach half of the payload.
The same test file keeps writes out of a `read_txn` body.

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

`apply_batch` holds the lock on the event loop;
[Work bounds under the write lock](#work-bounds-under-the-write-lock)
states what bounds its work.

## Planning

`ops_core.plan_op` turns one op and its context into effect tuples.
`ops_apply._context_for` classifies each op once (`classify_skip`, and
`replay_core.classify_text_edit` for a hashed edit) and hands `plan_op` the
context type that classification calls for, such as `TextConflictContext`
or `StuckMoveContext`. `apply_batch` reads the ack's skip, and charges a
hashed edit's `TextEditOutcome`, off the same context. A context that does
not fit its op is an `AssertionError`, a 500 the client retries, never a 400
that would poison the client's queue over a server bug.

- **Ordering.** An insert or move emits `ShiftSiblings`, bumping every
  sibling at or above the target `order_idx`. Nothing renumbers the gaps this
  leaves. A move onto its own slot still bumps every later sibling, because
  `ShiftSiblings` cannot tell staying put from moving there.
- **Refs.** Every text change emits `ReindexRefs`
  (`store.reindex_refs_for_text`, the only way a server write path changes
  `refs`). The schema's
  triggers keep `blocks_fts` and `changes` current but never `refs`, so a
  direct SQL `UPDATE blocks SET text` that adds or changes a link leaves
  backlinks stale. Edit linking text through the ops path (`pkm batch`).
- **Timestamps.** `blocks.updated_at` means last changed, so
  `set_collapsed` stamps neither block nor page; the journal still carries
  the collapse.
- **Idempotency.** A retried `batch_id` with a matching hash replays the
  stored ack with no effects; with other ops it is a 409. `ops_hash.py`
  holds both hashes and the guard fields the stored `batch_replay_hash`
  leaves out. A change to what either hash covers re-hashes every stored
  batch of that kind, and a retry across the deploy then 409s.
  `op_hashes.json` pins both hashes for every op kind, on the server and the
  web, and its `replay_excluded` list names the fields the worker fills.
- **Well-formed text.** `WellFormedModel` turns lone surrogates into U+FFFD
  ([Hostile input](backend.md#hostile-input)). The rule is to normalise,
  never reject: SQLite cannot bind a surrogate, a 5xx is retried forever and
  a 4xx poisons the batch. `text_hash` hashes the well-formed form, as the
  web does.
- **Text limits.** `ops_core.judge_batch` judges every op's text against
  the [text limits](#work-bounds-under-the-write-lock), a skipped op's
  included, before the title check, so `extract` never scans an over-long
  text. `post_ops` runs it in the threadpool before `BEGIN IMMEDIATE`, and
  a refused batch already in `applied_batches` replays its stored ack, so a
  tightened limit never 400s the retry of a batch whose ack was lost.
  `apply_batch` takes a `JudgedBatch`, which only `judge_batch` makes, by
  convention: nothing checks it.
- **Title reader.** `apply_batch` reads the title flag once
  (`title_reader`) and passes that one reader to every title the batch
  resolves, every replay and every landing. The replay must match titles
  as the rename or delete it replays did: under plain-space
  canonicalisation a `[[ Old ]]` the client added offline is the page
  `Old`, and left linked it re-creates it.

## Conflicts

Conflicts, missing targets, stale batches and concurrent structure edits are
what a batch meets when the tree changed after it was planned. None rejects
the batch.

`update_text` may carry `base_text_hash`, the sha256 of the text it was based
on; a hash, unlike a version counter, ignores structural change. On a
mismatch, or an edit to a gone block, the incoming edit wins and the losing
text, blank or not, lands under a `[[conflict]]` header on the daily page of
the batch's `now_ms`. A second conflict on a block the same day appends under
the same header.

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
`find_op_title_violation` never reads it. A header never links a page that
does not exist, or the ref indexer would create it (`conflict_notes.py`).
A page that exists is named by its stored title, never the hint's
spelling (`conflict_notes.existing_page_label`).

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
is last-write-wins.

A replay or stale unlink makes the written text differ from the sent text,
and the client hashes its next edit from what it sent. So
`ops_core.rewrite_effects` plans a `block_rewrites` chain (`RecordRewrite`)
from the sent text's hash to the written one. Each replayed step is recorded
whole, so that next edit replays all of it (`replay_core.rewrite_chain`).
The rows a stale unlink records come from `replay_core.stale_titles_linked`,
and a row already stored is not written again
(`ops_apply.BatchReplay.recorded`).

`delete` may carry `base_subtree_hash` over the uid and text of the block
and every descendant ([canonical form](sync-and-offline.md#conflicts-at-push-time)).
Order and nesting are not hashed, so a reorder does not diverge it. On a
mismatch the delete still wins, but first every descendant's text, blank
ones included, lands under the conflict header, nested, with fresh uids
(`ops_core.descendant_copy_effects`).

## Missing targets

An op whose block, or create or move parent, is gone is skipped. A batch is
atomic, so a 400 for one such op would take every valid op down and wedge the
client's queue. `ops_core.classify_skip` sorts it before
its context is read. Every row is reported in the ack's `skipped`
(`ops_core.skip_report`), with `note_page` null where nothing landed.

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
because the feed ships a block tombstone only from a delete row.

A skipped `create` or `move` shifted its destination siblings in the
client's optimistic apply but not on the server. Where nothing else re-ships
them, `ops_apply._destination_siblings` journals them.

Other planning errors are still a 400:

| Error | Judged by |
|---|---|
| a create's invalid or taken uid; a taken uid outranks a gone parent | `ops_core.plan_op` |
| title syntax in a `create`, `create_page` or `move` `page_title`, or in any ref a text holds | `find_op_title_violation`, before any op applies |
| a skipped op whose own uid, or whose gone parent (a diverted create's, or a move's whose block exists), fails `UID_RE`, which keeps arbitrary strings out of the journal | `ops_core.impossible_uid_reason` |
| a `create` or `move` that would put a block past `MAX_OUTLINE_DEPTH` | `ops_core._check_depth`; server-made landings are never refused for depth ([Work bounds](#work-bounds-under-the-write-lock)) |

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
| a leading `Title::` naming a stale title | fenced in place, `` `X`:: v `` (`unlink.defuse_attribute`), so it indexes no ref; the unlink replay defuses too |

`unlink_stale_refs` fences a link the unlink's passes leave, its title in
backticks inside its brackets (``[[`a[`]]``, `` #`T` ``). The link stops
resolving, and every character the user wrote stays.

A page re-created after its delete still matches until its row is pruned.

## Concurrent structure edits

| Op, situation | Outcome | Journalled |
|---|---|---|
| `create` under a live parent on another page than its `page_title` | created on the parent's page | the block |
| `move` under a parent no longer on the page `page_title` names | moved onto the parent's page | the subtree |
| `move` whose target is the block or its descendant | skipped as `move_cycle`, reported `cycle`; child `move skipped: would create a cycle` under the block's header | the moved subtree, root first |

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
| a query macro naming the page | refused: 409 with `blockers` (`DeleteBlockerModel`), `reason` `query`; nothing changes |
| a leading `Title:: v` | refused, `used_as_attribute`: the block's next edit would recreate the page |
| the inlined copies would carry the block past a text limit | refused, `limit` |
| unlinking would change the leading attribute name (`[[Title]]:: v`) | refused, `attribute` |
| rewritten text still references the page | refused, `residual` |

`unlink_title_refs` repeats until the text is stable, at most the text's
`[[` depth plus `PASSES_PAST_DEPTH` passes, since a nested legacy link loses
one layer per pass. A link the passes leave makes the source `residual`
(`unlink.unlink_settled`). Rewritten blocks get `unlink` and `inline` rows
and a reindex, and the title goes into `page_deletions`.

A server rewrite can grow stored text: a longer title per link, a copy per
`((uid))`, a stripped asset token that joins `[` to `[`.
[Work bounds](#work-bounds-under-the-write-lock) states each bound and
refusal.

`cleanup_journal` spares any daily note with an incoming link, so a link to a
journal day cannot dangle.

## Work bounds under the write lock

`apply_batch` runs on the event loop and holds the write lock until the
commit, so its work stalls every other request. That work is linear in the
request and in the rows and subtrees of the blocks the batch touches. What it
derives from the server's history is charged to the batch's replay budget.

| Bound | Constant | Judged in | Past it |
|---|---|---|---|
| a request body | `PRIVATE_BODY_MAX_BYTES` (`auth_gate_core.py`) | `auth_gate_core.private_body_cap`, in `AuthGateMiddleware` | 413 ([backend.md § Auth](backend.md#auth)) |
| ops in a batch | `MAX_OPS_PER_BATCH` (`contracts/ops.py`) | `OpBatch.ops`, as FastAPI validates the body | 422 |
| a client's block text | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING` (`contracts/ops.py`) | `ops_core.find_op_text_limit_violation` over `text_limits.text_limit_violation`, from `judge_batch` ([Planning](#planning), Text limits) | the whole batch is a 400, unless already applied |
| a page title a `create`, `create_page` or `move` names, or a ref title in a text | `MAX_PAGE_TITLE_CHARS` (`contracts/titles.py`) | `refs.title_length_over`, from `ops_core.find_op_title_violation` in `judge_batch` | as for a block's text |
| where a client's create or move puts a block | `MAX_OUTLINE_DEPTH` (`contracts/ops.py`) | `ops_core._check_depth`, from `plan_op` | the whole batch is a 400 |
| where a conflict entry or a diverged delete's copy lands | `MAX_OUTLINE_DEPTH` | `ops_apply._conflict_landing`, `ops_core.descendant_copy_effects` | never refused; placed no deeper than the cap |
| a conflict header or skip note naming a page | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING` | `conflict_notes._fitted` | the name becomes `LONG_TITLE_LABEL` |
| one replay step | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING`, `MAX_UNLINK_WORK` (`text_limits.py`) | `replay_core._replay_step`, before it splices (`spans.spliced_length`, `text_limits.unlink_refused`); then `classify_text_edit` judges the result | the edit lands `over_limit` |
| a batch's replays | `MAX_BATCH_REPLAY_WORK`, `ROW_CHARS` (`replay_core.py`) | `ops_apply.BatchReplay._spend`, from `BatchReplay._read` and `BatchReplay.charge` | the edit lands `over_limit`; its step spends what is left, so every later step stops before splicing |
| a route's rewrite of stored text: rename, merge, title migration, asset strip | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING` | `text_limits.rewrite_text_limit_violation`, from `store.rewrite_snapshotted_blocks` (`RewriteTextLimitError`) and `routes_assets._strip_references` | refused before any block is written: a rename or merge 422, the migration 409, the strip 409 with `blockers` ([files-and-assets.md](files-and-assets.md#assets-and-the-file-browser)) |
| a page delete's copies: per page block, per source, and in total | `MAX_BLOCK_TEXT_CHARS`, `MAX_LINK_NESTING`, `MAX_UNLINK_WORK`; the total, `MAX_DELETE_COPY_CHARS` (`unlink.py`) | `unlink._copy_length`, from `unlink.plan_page_delete` in source order | the source is refused, blocker `limit`, on the delete and its preview alike |

The text limits exist because export holds a whole block in memory and the
web tokenizer recurses once per nested run. The depth cap exists because the
page, block and journal reads answer 500 on an outline 255 levels deep:
pydantic-core's serialiser has a fixed recursion guard, so one bound on
writes protects every reader.

**A 400 is only ever over what the client sent.** A client's own text,
titles and placements are refused whole. Text and placement the server makes
(a replay, a stale unlink, a conflict header, a diverged delete's copies) are
never refused, because a 400 discards the client's whole offline batch.
Server-made text passes a limit only by copying a stored row that predates
the limits, or by the two backticks of an unlink's fence
([Stale batches](#stale-batches)).

An op may leave an over-limit stored row at its length or shorten it, never
lengthen it. Only the text an op sends is judged, so a move, `set_*` op or
delete of such a row goes through. A server rewrite
(`rewrite_text_limit_violation(before, after)`) and an unlink
(`unlink_refused`) both allow level, so the page a legacy row links stays
renamable and deletable. Depth is stricter: a move that leaves a legacy
subtree past the cap is refused.

An `over_limit` edit lands as sent, with every title its replay deleted or
renamed away made plain (`replay_core.over_limit_landing_text`).

The replay budget is counted in characters. A block can hold millions of
rows, and without the budget a batch of tiny edits could hold the write lock
for minutes.

| Work | Charge |
|---|---|
| reading the rows from one base hash (`ops_apply._rewrites_within`) | each row's old and new text in bytes, plus `ROW_CHARS`, sized before any text loads (`_CHARGED_REWRITES`) |
| an unlink | what the capped unlink can read (`unlink.unlink_reads`) |
| a rename | the text it scans plus the text it splices, since a longer title grows every link |
| the [rows](#conflicts) an op records for a step that changed its text (`replay_core._charged`) | each row's old and new text, plus `ROW_CHARS`; an inline row's new text is its copy |
| a move or delete of a large subtree, which rewrites or hashes every descendant | nothing |
| the stale-title load (`store.stale_titles`), once per batch | nothing; it is linear in the pages deleted since the batch's `seen_seq`, which the client sends |

The uncharged costs grow with stored data, and a batch can repeat them
([SECURITY.md § Known limitations](../SECURITY.md#known-limitations)).
Beyond its charge, no op's work may grow with the block's rows or a step's
titles. The docstrings of `replay_core._spent`, `replay_core._cached_step`
and `ops_apply.BatchReplay.walk` say how each step is charged once.

A page delete judges each copy at its projected length before building any
(`unlink._copy_length`, `unlink._Copies`), so it can refuse a delete whose
final text would fit. A projected `limit` is reported ahead of `attribute`
and `residual`, so the delete dialog names the length first.

`plan_op` judges a create or move by the level of the deepest block it
places, with the batch's earlier ops applied; a skipped op is not judged.
A depth violation is a 400 for the whole batch, not a skip like
`move_cycle` (`ops_core._check_depth` says why). The
[design](../superpowers/specs/2026-10-24-outline-depth-cap-design.md)
accepts the cost: a web offline batch is
[discarded](sync-recovery.md#a-batch-the-server-rejects) when two devices'
edits, each legal alone, stack past the cap. The web refuses what it can see
first ([frontend-editor.md](frontend-editor.md#rules-an-edit-must-not-break)).
A server-made landing keeps all its text at the cap and loses only the
nesting below it (`ops_core.descendant_copy_effects`).

## Post-commit nudges

**Every route whose commit touches a journalled table (`blocks`, `pages`,
`sidebar_entries`) sends a WS `{type:"seq", seq}` nudge right after that
commit.** `seq` is the real journal maximum. A metadata or generation change
that may not advance `changes.seq` adds `force:true` and the new
`generation`, which makes a client pull at its own cursor without advancing
it. `POST /api/ops` also echoes the applied ops.

A route under [`write_txn`](#the-write-lock) nudges after its `with` block:
`notify.nudge_threadpool` from a sync-def route, `await nudge(request, db)`
from `post_ops`. `test_journal_advancing_contract.py` asserts the nudge only
for the routes on its hand-kept list, so a new journal-advancing route adds
its own case there.

```mermaid
flowchart LR
    B["Hub.broadcast()"] --> Q["per-client queue<br/>(QUEUE_SIZE)"]
    Q --> D["drain task,<br/>one per connection"]
    D -->|"send_json under SEND_TIMEOUT"| C([client])
    Q -.->|"queue full, or send times out"| X([disconnect and close])
```

`Hub.broadcast()` (`ws.py`) never awaits a send, so a stalled client blocks
neither the write path nor other clients. A client receives frames in call
order only while its `_drain` task is the sole consumer of its queue.
Dropping a client closes the socket (`_safe_close`), or `onclose` never fires
and the client never resyncs.
