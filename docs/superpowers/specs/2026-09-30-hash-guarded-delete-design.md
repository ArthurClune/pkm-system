# Hash-guarded delete (pkm-nny8)

Brainstormed with Arthur 2026-09-30. Parent epic: pkm-a4t2.

## Problem

Structural ops are last-writer-wins. A `delete` that arrives after an edit
it never saw removes that edit with no conflict copy; the reverse order is
safe (the edit becomes an orphan edit on the daily note). `delete` is the
only structural op that destroys text, and the realistic trigger is a device
deleting a block while offline while another device edits it (or its
subtree) meanwhile. `docs/architecture/sync-and-offline.md` states the gap as
open.

## Outcome

A delete whose subtree changed since the deleting device last saw it still
wins, and the server's current texts for that subtree land, nested as they
were, under the block's daily-note conflict header. Who wins is unchanged.
Nothing new is needed on replicas.

## Decisions

| Question | Decision |
|---|---|
| What lands on divergence | The whole subtree (one hash cannot say which descendant changed) |
| What the hash covers | The set of `(uid, text)` pairs of the subtree, sorted by uid |
| Landing shape | Nested copies with fresh uids under a `— deleted while edited elsewhere` header; text only |
| Hashless delete | Applies as today (older clients) |
| CLI / MCP | `pkm batch` `delete` is guarded like an interactive delete |
| Named hash type | Out of scope: pkm-r5ra |
| Perf | A delete-scenario change under 5% is re-recorded without review; larger goes to Arthur |

What the hash covers, and why: divergence means text the delete would
destroy that the deleting device never saw. That is a changed text, a child
another device added, or a block another device moved into the subtree; all
three change the `(uid, text)` set. Reorders, re-parenting inside the
subtree, collapse, heading and view type lose no text, so they are left out
and never manufacture a conflict copy.

The failure direction is always an extra copy, never lost text: a stale stamp
(say the main-thread tree lags a feed edit the replica already holds) or a
rename that rewrote a descendant's `[[link]]` produces a copy of text that was
not lost. Deletes do not replay `block_rewrites`; that would need per-block
hashes.

## 1. Contract and hash

`DeleteOp` (`server/src/pkm/contracts/ops.py`) gains

```python
base_subtree_hash: str | None = Field(default=None, min_length=64, max_length=64)
```

`openapi.json` and the web types are regenerated.

**Canonical hash.** A pure `subtree_hash(pairs)` in `contracts/ops.py` beside
`text_hash`, and its web twin beside `sha256Hex`:

```
sha256( "\n".join(f"{uid} {text_hash(text)}" for uid, text in sorted(pairs)) )
```

Each text is hashed on its own rather than JSON-encoding the pairs, because
Python and JS escape JSON strings differently; `text_hash` / `sha256Hex`
already agree. Uids are ASCII (`UID_RE`), so both languages' default sorts
agree. A new fixture `shared/fixtures/subtree_hash.json` (subtrees and their
expected hashes: unicode, empty text, a single block, deep nesting, uids
whose sort order differs from tree order) is pinned by a server test and a
web unit test, like `draft_flush.json`.

**Idempotency** (`server/src/pkm/server/ops_hash.py`):

- `_canonical_op` drops `base_subtree_hash` from a `DeleteOp` while it is
  `None`, so every existing `applied_batches` hash still matches.
- `_canonical_replay_op` pops it from `delete`: the worker fills the durable
  copy while the fallback-lane copy of the same `batch_id` stays unfilled,
  and a lost enqueue reply sends both. Without this the second delivery 409s
  (the 2026-09-28 final review caught exactly this for a new field).

## 2. Stamping

The rule is `update_text`'s: stamp only when the field is `undefined`, hash
against the tree the batch was planned from, walk the batch in order so op N
sees what ops before it left.

- **Main thread**: `web/src/outline/baseTextHash.ts` `stampBaseTextHashes`
  also stamps `delete`, from the node's subtree in the walked tree. No node
  found: no stamp (the worker may fill it). So a batch that moves B's
  children out and then deletes B hashes only what is left, and an update of
  a child followed by a delete of its parent hashes the updated text.
- **Worker**: `web/src/replica/queue.ts` `enqueueBatch` fills the field when
  absent, from a recursive query on the replica, BEFORE that op's optimistic
  apply. A caller-supplied hash is stored as sent.
- **Undo**: history already records deletes unstamped (`useOutline` strips
  only the flushed text op, which is the one op that arrives pre-stamped), and
  `undoManager.dispatch` stamps through `stampBaseTextHashes` at replay time,
  so an undo that deletes (the inverse of a create) hashes the tree at replay
  time with no change to `withoutStamps`.
- **CLI / MCP**: `pkm batch`'s `delete` (`server/src/pkm/batch.py`, shared by
  the MCP batch tool) is stamped from `GET /api/block/{uid}`, which already
  returns the block's subtree, advanced through the batch's earlier ops the
  same way the main thread walks a batch. The workflow
  (`client/workflows.py` `apply_batch`) does the fetches and hands the
  subtrees to the pure planner, as `PageBlocks` is handed in today. A uid the
  batch itself created (an alias) gets no hash: the server cannot have edited
  it. A fetch that 404s sends the delete hashless, so the server still skips
  it and the ack's `skipped` list still reports it (the documented
  `pkm batch` contract; `cmd_batch` exits 1).

## 3. Server planner and landing

**Reading** (`ops_apply._context_for`, shell):

- No hash: `DeleteContext` as today, no extra reads.
- Hash: the subtree CTE also selects `parent_uid, order_idx, text` (still one
  query), and the shell computes `subtree_hash`.
  - Match: `DeleteContext`.
  - Mismatch: a new `DeleteConflictContext(block, subtree, page_title, rows,
    landing)`. Only this case resolves today's daily page. The landing carries
    one freshly minted copy uid per row as well as the header uid (the core
    cannot mint).

**Planning** (`ops_core.plan_op`, core), for `DeleteConflictContext`:

1. The header: today's existing one for this uid, or a fresh one recorded in
   `conflict_headers` (unchanged `RecordConflictHeader` rule).
2. An `InsertBlock` + `ReindexRefs` per copy, root first: the root copy under
   the header at its next index, each descendant copy under its parent's
   copy, renumbered 0..n in the server's order.
3. `DeleteBlocks(subtree)` and `TouchPage` for the block's page and the
   daily page. The delete still wins.

The root copy goes through `conflict_entry_effects` unchanged, so every
conflict path shares one header-and-record path; the descendant copies follow
it as plain `InsertBlock` + `ReindexRefs` effects, parent copy before child. `conflict_notes.deleted_header_text` gives

```
[[conflict]] [[Page]] — deleted while edited elsewhere
```

with `Page` read from the block's own row before the delete and labelled
through `existing_page_label`, like `overwritten_header_text`. It cannot
embed `((uid))`: the block is gone.

**Edges**

- A delete of a block already gone is `classify_skip`'s `noop`, before any
  hashing. Unchanged.
- If today's header for this uid already exists from an earlier
  `overwritten by ((uid))` conflict, the copies append under it and its
  embed now points at a deleted block. Accepted: that header describes the
  earlier conflict and the copies still hold the text.
- A `((ref))` in a copy to a block inside the deleted subtree renders broken,
  as for any deleted block today.
- Feed windows: the copies are fresh uids on the daily page, not descendants
  of anything deleted, so the "tombstones lead" window rule has nothing to
  order. Replicas: the originating device's local delete applies as today;
  the copies reach every replica over the feed.
- F2's single transaction covers the copies: a failure later in the batch
  rolls them back with everything else.

**Cost**: a matching guarded delete adds no query, only O(subtree) hashing.
A mismatch adds one daily-page resolution and N inserts and reindexes.

## 4. Testing

Tests first, per task.

- **Fixture** `subtree_hash.json`, pinned both sides.
- **Server core**: `DeleteConflictContext` effects (nested renumbered copies,
  fresh versus existing header, header labels for a title that links back and
  one holding a backtick); `subtree_hash` against the fixture.
- **Server routes**: match deletes with no daily entry; mismatch from a
  descendant edit, a child added elsewhere, and a block moved in lands a
  nested copy; a reorder or indent inside the subtree lands none; hashless
  applies as today; a mid-batch failure rolls the copies back; a pinned
  literal `batch_request_hash` for a hashless delete proves old hashes are
  unchanged; the filled and unfilled copies of one `batch_id` replay rather
  than 409.
- **Web unit**: main-thread stamping follows the batch walk (children moved
  out then delete; child update then delete); the worker fills before the
  optimistic apply and defers to a supplied hash; an undo replay stamps a
  delete against the replay-time tree.
- **CLI planner**: batch delete stamped from a fetched subtree; alias gets no
  hash; update then delete in one batch; 404 sends hashless.
- **Playwright**, a new test in `web/e2e/conflict-landing.spec.ts` using its
  pattern: the browser's `POST /api/ops` for a delete made in the editor is
  held in a route handler while another client edits the block's child
  through `page.request`; once released, the nested copy sits under the
  header on today's daily note. Own `E2E_PORT`; deletes what it creates.

## 5. Docs (same branch)

- `docs/architecture/sync-and-offline.md` § Conflicts at push time: the
  `delete` row becomes the landing rule; one sentence on the canonical hash
  and its fixture.
- `docs/architecture/backend.md` § Conflicts: the new header form in the
  header table; the "`delete` carries no hash" paragraph replaced by the rule.
- `docs/architecture/cli-and-mcp.md`: `pkm batch` `delete` fetches and is
  guarded; a missing uid still reports through `skipped`.
- No `docs/troubleshooting.md` row: this closes a documented gap, not a
  reported symptom.

## 6. Verification

Full server (pytest, pyrefly, ruff) and `web pnpm verify` on the branch;
`perf/check.sh backend` and `frontend` after merge. Delete scenarios moving
under 5% are re-recorded with `--bootstrap` and the reason in the commit;
anything larger goes to Arthur with the table.
