# Page delete wins over stale offline edits — design

Date: 2026-10-14. Follows `pkm-wlkh` (page delete unlinks references) and
`pkm-xsgt` (attribute pages refuse delete). Beans: the product change
(`pkm-ynze`) and `pkm-wvac` (the sync property suite), in that order.

## Intent

Arthur's rule: once a page is deleted, content that was written for it on a
device that had not yet seen the delete must not bring the page back. The
content itself must never be lost: it is parked in today's daily note, the
way orphaned edits are parked today. Links follow the same rule: in
anything a device wrote before it saw the delete, every link to the
deleted page becomes plain text, whether it was typed offline or carried
over (a block split copies its links into a new block, and the server
cannot tell the two apart). Only a device that has seen the delete can
bring the page back, by linking or creating it.

Page delete itself is online-only (`TopBar.tsx` calls
`DELETE /api/page/{title}` directly; nothing is queued), so the reverse
race, a stale delete firing later against content it never saw, cannot
happen and is out of scope.

## Today's behaviour, and the target

A "stale" op is one built on a device whose replica had not yet received
the delete.

| Stale op touching deleted page X | Today | Target |
|---|---|---|
| `update_text` on one of X's blocks | `orphan_edit`: text parked in daily note, X stays deleted | same |
| `create` under a parent that was on X | `diverted_create`: parked | same |
| top-level `create` with `page_title` X | re-creates X with the block | parked in daily note; X stays deleted |
| top-level `move` with `page_title` X | re-creates X, moves the block there | block stays where it was, a note lands (as `move_parent_missing`) |
| `create_page` X | re-creates X (empty) | no-op; X stays deleted |
| hashed `update_text` elsewhere whose base text had `[[X]]` | unlink replay (`block_rewrites`) makes it plain text | same |
| any parked text containing `[[X]]` / `#X` | parked text is re-indexed and re-creates X | links to X become plain text before it is parked |
| `[[X]]` in the text of any other `create` or `update_text` (typed offline, or copied by a split) | re-creates X | becomes plain text (Arthur chose this stricter rule over "a typed link re-creates") |

Every unlink above uses the same `unlink_title_refs` the delete used,
matched through the same `title_reader` canonicalisation, and runs on the
op's text before planning, so the planned write, any conflict copy and
any parked copy all see plain text.

A non-stale op (built after the device saw the delete) behaves as today:
a top-level create on X, or a new `[[X]]`, after seeing X deleted is a
deliberate new page X.

## Mechanism

The server cannot tell stale from deliberate today: an `OpBatch` carries
only `client_id`, `batch_id` and `ops`, pages are named by title on the
wire, page ids are reused, and nothing remembers a deleted page's title.
Two additions close that gap.

1. **A page-deletion record on the server.** Every user page delete
   (`store.delete_page_unlinking`, i.e. `DELETE /api/page/{title}`) writes
   a row: canonical title, the sync-feed seq at which the delete happened
   (the seq of the page tombstone the journal trigger writes, or the
   journal's high-water mark right after the delete), and `deleted_at`.
   Several rows per title are allowed (deleted, re-created, deleted again).
   Rows are pruned on the same 30-day window as `block_rewrites`
   (`BLOCK_REWRITE_RETENTION_MS`); a batch staler than that re-creates the
   page as today.

   Not recorded: `cleanup_journal` (it deletes empty, unlinked recent daily
   notes; a stale offline edit to yesterday's daily must land in yesterday's
   daily, as today) and the page removal inside a rename merge or the title
   migration (renames have their own retitle replay). A user delete of a
   daily-note title is not recorded either (my call): parked text always
   lands in today's daily, the replica creates today's daily locally with
   no op, and a daily is re-created on demand anyway, so "stays deleted"
   cannot hold for it.

   The record holds only the title the page had when deleted (my call). A
   stale op naming an older title of a page renamed and then deleted still
   re-creates under the old title; stale ops naming a renamed page's old
   title are a rename problem, out of scope here (`pkm-7v8l`).

2. **A seen-seq on each batch.** `OpBatch` gains an optional field holding
   the client's sync cursor (the `since` it would next pass to
   `/api/sync/changes`) at the moment the batch's ops were built. The web
   client records it at enqueue time (`enqueueBatch` in the replica
   worker, where the cursor lives), not at send time. The queue never
   merges batches.

A title X is **stale for a batch** when a deletion record for X has a seq
greater than the batch's seen-seq. A batch with no seen-seq (queued by an
app version from before this change), or with a seen-seq greater than the
journal's latest seq (a cursor from a replaced database; see the
`since > latest` branch in `routes_sync.sync_changes`) is handled as
follows (my call):

| Batch | Treated as |
|---|---|
| has a seen-seq ≤ latest | stale for titles deleted after it |
| has a seen-seq > latest (replaced database) | stale for every recorded deletion; parking never loses text |
| no seen-seq | built against current server state: never stale |

"No seen-seq" is the CLI and MCP (`PkmClient.post_ops`, which plan
against live server state and fold in a `create_page` for a missing
title), the web app's online-only no-replica mode, and the opQueue's
in-memory lane if it cannot reach the cursor. Treating them as stale
would park a deliberate "add a note to Foo" for 30 days after Foo was
deleted, which is the anti-goal. The cost: a batch queued by an app
version from before this change, still unsent at deploy, behaves as
today. The web replica path must always send a seen-seq; the builder
makes the in-memory lane send one too if the cursor is reachable.

Staleness is checked by title, independent of whether X currently exists:
if X was deleted after the batch's seen-seq and then re-created by someone
else, a stale top-level create meant for the old X is still parked, not
added to the new X (my call: consistent, and lossless).

Where it plugs in (from `ops_apply` / `ops_core`; the builder confirms):
`apply_batch` → `_context_for` → `classify_skip` / `_resolve_page`. The
three top-level paths (`create`, `move`, `create_page`) resolve their page
through `_resolve_page`; a stale title there becomes a new skip kind (or
reuses the closest existing one) planned through `_plan_skip` /
`_plan_skip_own`, so the ack's `skipped` reports it and the client repairs
exactly as it does for `diverted_create` today. The unlink of stale
titles applies to the text of every `create` and `update_text` in the
batch, before the op is planned, so it covers applied writes, conflict
copies and every parked-text path (`_plan_skip_own`, where
`conflict_entry_effects` emits `ReindexRefs`) alike. It composes with the
existing `block_rewrites` replay: the replay rebases the base, the stale
unlink cleans the client's new text. The pure decisions stay in the Functional Core
(`ops_core`, `unlink`); the record lookup is shell.

The parked entry's header names the deleted page as a code span, as
`conflict_label` already does for titles that no longer exist.

## Contract and client

- `OpBatch` new optional field (name is the builder's; `seen_seq` is the
  suggestion). Regenerate `web/src/api/openapi.json` and `types.d.ts`.
- The skip kind, if new, joins the ack's `skipped` reasons; the web client
  treats it like `diverted_create` (its optimistic block is removed and the
  parked entry arrives through the sync feed). The replica's local
  `create_page`/top-level create of X while offline is optimistic and is
  corrected by the feed like any other server-side divergence.
- The local replica (`web/src/replica`) does not need to model the rule;
  the server is authoritative and the feed converges the replica.

## Property suite (`pkm-wvac`)

Built after the product change, on top of it.

- Harness server (`server/tooling/proptest/sync_server.py`): log user page
  deletes the way `proptest_renames` logs renames (title, `after_batch`,
  clock), with a `GET /__proptest/deletes` control route.
- Commands (`web/src/props/sync/commands.ts`): a `DeletePage` command drawn
  from the title pool, issued online through the drawing client's transport
  (`DELETE /api/page/{title}`), with outcomes `deleted`, `refused 404/409`
  and `failed offline`, like `Rename`. The arbitraries must keep drawing
  offline edits, top-level creates and moves on pages that later get
  deleted, otherwise the race is never exercised.
- Serial replay (`oracle.ts`): replay each logged delete after the batch it
  followed, at the clock it ran at, interleaved with renames in commit
  order. The replay server's sync seqs will not equal the faulted run's,
  so a recorded body's seen-seq cannot be replayed verbatim; the oracle
  maps each seen-seq to the same position relative to the logged deletes
  (e.g. rewrite it to the replay server's seq for the last delete the
  faulted seen-seq had passed). The builder chooses the mapping; what must
  hold is that each batch is stale for exactly the same titles in both runs.
- A new invariant, **delete wins**, alongside convergence and serial
  replay: at quiescence, no block uid that belonged to a deleted page
  exists anywhere, and a deleted title exists afterwards only if a
  non-stale op linked or created it. The exact formulation is the
  builder's, as long as it fails on today's behaviour (a top-level create,
  a split's copied link, or parked text re-creating the page).
- Budget: the web property gate's time grows with suites; keep the sync
  suite's added cost proportionate (a weight like `Rename`'s).

## Goals, non-goals

Pre-existing behaviour noted by the builder check and left alone:
`batch_replay_hash` and `skip_report` may need to learn the new field
and skip; the replica's `dropStrandedLocalPages` already removes a local
page the server skipped.

Goals: deleted pages stay deleted against stale content; no text is ever
lost; only a device that has seen the delete can bring the page back;
the multi-device suite proves it.

Non-goals: queuing page deletes offline; changing rename/merge semantics;
changing `cleanup_journal`; a client-side model of staleness.

Anti-goals: any path that drops text silently; parking a deliberate new
page because its title was once deleted by the same up-to-date device.

## Docs to update

`backend.md` (ops contract field, the deletion-record table under
"Database", the delete section's stale-op rows), `sync-and-offline.md`
(seen-seq at enqueue, the new skip kind), `property-checks.md` (control
routes, the delete-wins invariant), and a `troubleshooting.md` row
(symptom: deleted page reappears after another device syncs).

## Left to the builder

Field and table names; whether the new skip is a new kind or reuses one;
how the deletion seq is captured; the seen-seq mapping in the oracle; the
exact delete-wins formulation.
