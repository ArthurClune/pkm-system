# Deleting a page unlinks its references

Bean: pkm-wlkh. Status: design, 2026-10-13.

## Why

Pages mostly get deleted because they were created by mistake: a typo
(`[[pag]]` for `[[page]]`), or an agent writing `#1 in rankings`, which
the tag grammar reads as a tag on a page called `1`. After a delete today,
the inbound text still says `[[pag]]` / `#1`, so:

- the next edit to any of those blocks re-derives its refs and **recreates
  the deleted page** (`store.index_ref` -> `get_or_create_page`), so the
  delete does not stick;
- if the page is recreated, its backlinks are missing the old blocks until
  each is edited again;
- `((uid))` references into the deleted page's blocks silently dangle.

The pkm-70ty sweep (prod, 2026-10-13) found 13 such blocks: links to
deleted `Keyboard shortcuts` and to tag pages `1`, `3`, `4`, `5`, `18`
(mostly the agent-written LLM/Releases table), and links to four daily
notes the journal cleanup deleted while other pages still linked them.

Arthur's rule: **deleting a page turns the links to it into plain text,
and nothing about the delete leaves a reference that can bring the page
back or point at nothing.**

## Goals

1. On delete, every inbound page reference in another page's block text
   becomes the plain title:
   - `[[pag]]` -> `pag`
   - `#1` -> `1` (so `#1 in rankings` -> `1 in rankings`)
   - `#[[A B]]` -> `A B`
   - `[label]([[A]])` -> `label` (my call: there is no alias concept in
     the grammar today, but leaving `[label](A)` would be a broken
     markdown link)
   Code spans and fences are left alone, as rename leaves them.
2. Every `((uid))` on another page that points into one of the deleted
   page's blocks is replaced by a plain copy of the referenced block's
   text, and so is the embed form `{{embed: ((uid))}}` /
   `{{[[embed]]: ((uid))}}` (whole macro replaced; my call). Arthur
   agreed what the copy is:
   - the referenced block's text as it reads now, keeping links to other
     pages and refs to blocks that survive;
   - minus a leading `{{[[TODO]]}}`/`{{[[DONE]]}}` marker and a leading
     `Name::` prefix, so the copy cannot turn its host block into a task
     or an attribute;
   - newlines folded to single spaces, so a multi-line copy cannot break
     the sentence or table cell it lands in;
   - the deleted page unlinked as in goal 1, and any `((uid))` in the copy
     that points into the deleted page inlined the same way, one level
     deep; anything still pointing into it after that becomes the empty
     string (cycles end there).
   Only the block's own text is copied, not its children (my call).
3. The delete confirm dialog says what will happen before it happens:
   how many links on how many pages become plain text, and, when there
   are any, a clear warning that N block references on M pages will be
   replaced with copies of the text. The user can cancel or carry on.
4. The journal's automatic cleanup never deletes a daily note that has
   an incoming link of any kind (`[[link]]`, `#tag`, attribute, or
   `((ref))` into it). A daily note with an incoming link is kept, empty.
5. A device that edited one of the rewritten blocks offline, before
   seeing the delete, does not undo it: when its stale edit arrives, the
   unlink (and any inlining) is replayed over its text, exactly as a
   rename is replayed today, so the page is not recreated and no
   conflict copy is filed for what is only the unlink.
6. The delete is one transaction: rewrite, reindex, record replay rows,
   delete the page. A failure leaves everything as it was.
7. **Some references block the delete.** If any of these exist, the
   delete is refused and the dialog lists each blocking block (its page,
   linked, and its text) so the user can fix them first; there is no
   override:
   - a query macro (`{{query: …}}` / `{{[[query]]: …}}`) whose expression
     names the page. Unlinking would break the query, keeping it would
     recreate the page, dropping the operand would silently change its
     results (Arthur: refuse, list them, very rare);
   - a link in attribute position, e.g. `[[page]]:: v`, where unlinking
     would create the attribute `page:: v` and so recreate the page
     (Arthur: refuse).
   The server enforces this too: `DELETE` returns 409 with the same list
   when blockers exist, so a stale dialog cannot get past it.

## Non-goals

- Deleting an attribute page (one referenced as `Name:: value`). Arthur:
  that would be a major error, but it is out of scope for now. Attribute
  references are left as they are, as today. A later bean should make
  delete refuse, or warn hard, when the page has attribute references
  (the goal-7 refusal makes that a small addition).
- Stale offline *block deletes*. Rename's replay covers stale text edits
  only; a stale delete of a block the server has since rewritten is
  compared against the rewritten text (`delete_diverged`) and files a
  delete-conflict copy, as it does after a rename today. My call: keep
  parity with rename and leave this as a known limitation, not part of
  goal 5.
- Deleting from the CLI, MCP or assistant. None of them can delete a page
  today; this does not add it.
- Deleting offline. Delete stays online-only, like rename
  (`sync-and-offline.md`, "Ancillary details").
- Undo. The dialog already says the delete cannot be undone.
- Bulk deletes of heavily linked pages. The common case is a small
  mistaken page with a handful of links.

## Anti-goals (failure even if it "works")

- A delete that leaves any text from which the page, or a ref into its
  blocks, can be re-derived.
- A rewrite that lands on a block without its refs being re-derived (the
  pkm-70ty failure mode). Every rewritten block goes through
  `reindex_refs_for_text`.
- A stale device's offline edit to an unlinked block that either
  resurrects the page or files a spurious conflict copy.
- The journal cleanup unlinking anything. It keeps linked daily notes; it
  never rewrites.

## Decided shape of the how

These follow from the existing code (see the rename path,
`docs/architecture/backend.md`, "Page mutations and the sidebar" and
"Conflicts"):

- **Reuse rename's frame.** The delete route takes the write lock up
  front (`BEGIN IMMEDIATE`, 503 + `Retry-After` when busy) as rename
  does; today's delete has no lock and must gain one. It snapshots the
  inbound blocks, rewrites each through one choke point that updates
  text, records a replay row and calls `reindex_refs_for_text` (the shape
  of `store.rewrite_snapshotted_blocks`), then calls `delete_page_rows`.
  Replicas need no new mechanism: rewritten rows arrive through the
  `changes` feed as any server write does.
- **Two snapshots.** Page refs come from `refs.target_page_id` (as
  `_snapshot_referencing_blocks` does). Block refs need a new query:
  blocks on other pages whose `block_refs.target_block_uid` is one of
  the deleted page's block uids. A block in both sets is rewritten once,
  with both rewrites applied.
- **New pure rewriter.** `rename.py`'s walk (code stripping, nesting,
  tag/attribute/bracket spans) can only re-spell a title in the same
  syntax. Unlinking needs a sibling function in the same functional-core
  module that emits plain text for a matched span (and covers the `#` of
  `#[[A]]` and the alias wrapper), plus a pure function that replaces
  `((uid))` / embed macros with given texts. Both get unit tests in the
  style of `server/tests/test_rename.py`.
- **Replay generalises `block_rewrites`.** Today each row is a
  title->title map and `ops_core.replay_title_rewrites` is hard-wired to
  `rewrite_title_refs_map`. The table and replay gain a kind, so a row
  can say "unlink title A" or "inline ((uid)) as this text", and the
  replay applies the matching pure rewrite. Same hash chaining, same
  30-day retention, same `MAX_REPLAYED_REWRITES` cap.
- **Preview route.** The dialog's content comes from a new read-only
  route (e.g. `GET /api/page/{title}/delete-preview`) returning link
  count and page count, block-ref count and page count, and the goal-7
  blockers (uid, page title, text for each). The delete itself does
  whatever is true at delete time; a change between preview and delete
  is not an error, except that blockers found at delete time refuse it
  (409).
- **Query detection.** The server's `refs.extract` does not distinguish
  query bodies; the web tokenizer does (`web/src/grammar`). The server
  needs to recognise a query macro around a ref to find goal-7 blockers.
- **Journal cleanup** spares a daily note when any inbound page ref
  (`refs.target_page_id`) or block ref (`block_refs`, replacing today's
  `text LIKE '%((uid))%'` scan) exists.

## One-off data repair (after the feature ships)

The 13 blocks from the pkm-70ty sweep, via `pkm batch` with Arthur's OK:

| Target (deleted) | Blocks | Repair |
|---|---|---|
| `1`, `3`, `4`, `5`, `18` (tags) | 8 (7 on LLM/Releases, 1 on Bork Protocol) | `#1` -> `1` etc., plain text |
| `Keyboard shortcuts` | `RY9E8_vcn` on Roam | plain text |
| `July 28th, 2026`, `July 30th, 2026`, `September 30th, 2026` (daily) | 4 | recreate the empty daily note, then re-derive the blocks' refs (the update-and-restore batch from pkm-70ty) so backlinks return |

Re-run the pkm-70ty sweep afterwards; it should report zero.

## Left to the builder

- Exact names, response shape of the preview route, and dialog wording
  (within goal 3: counts plus a clear warning when block refs exist).
- How nested legacy links (`[[A [[B]]]]`, possible only in imported data,
  since titles can no longer contain `[[`) are handled when B is deleted,
  provided the anti-goals hold: no text left that re-derives B.
- Whether replay rows for inlining store the copied text or enough to
  recompute it.
- Test layout, provided there are: pure rewriter tests; endpoint tests
  for delete (unlink, inline, embed, 409 with the blocker list for a
  query naming the page and for `[[page]]:: v`, transaction rollback,
  503 when the lock is busy, the existing
  `test_delete_page_removes_inbound_refs_but_leaves_source_block_text`
  rewritten to the new rule); stale-edit replay tests beside
  `test_stale_edit_replays_a_rename_instead_of_resurrecting_the_title`;
  journal cleanup tests for each kind of incoming link; a web test for
  the dialog text.

## Done means

- The tests above, plus the full server and web gates (AGENTS.md
  "Testing"), `perf/check.sh` and `proptest/check.sh server` before merge.
- `web/src/api/openapi.json` regenerated for the new route.
- Docs updated: `backend.md` (API table rows for DELETE and the preview
  route; "Page mutations and the sidebar"; "Conflicts" replay kinds;
  `block_rewrites` in "Database"), `sync-and-offline.md` (replay table
  row), and the `test_delete_page_*` docstring claim "inbound links are
  left as-is" removed wherever it is repeated.
- The one-off repair applied and the sweep at zero.
