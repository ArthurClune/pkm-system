---
# pkm-xjew
title: 'Docs corrections from the sync review not tied to a fix: D6, D7, carried-over items, AGENTS.md comment rule, shape pass'
status: completed
type: task
priority: normal
created_at: 2026-09-29T13:20:47Z
updated_at: 2026-09-29T16:24:57Z
parent: pkm-a4t2
---

Review § Docs versus code and § Accepted limitations. The fixes carry D1 to
D4 themselves. This bean is the docs-only commit for the rest, then the shape
pass under the `architecture-docs` skill. Say what was corrected versus added
in the commit message.

Corrections:

- D6: `sync-and-offline.md` and `backend.md` say "all three change together"
  of one recursive-walk lineage; `localOps.parentChain` and
  `ops_apply._parent_chain` are a second independently mirrored pair neither
  enumerates.
- D7: the sentence scoping landed with pkm-impk (`sync-and-offline.md` now
  reads "A conflict copy is never discarded"). Remaining: note the
  stale-delete gap as open until the hash-guarded delete ships.
- The post-latch ordering inversion (`opQueue.ts`) exists only in a code
  comment: a failure-table row.
- `sync-recovery.md` reads as if the placement table were shared;
  `missing_targets.json` pins skip-or-not only.
- `frontend.md` module map omits `sync/unloadGuard.ts`, `replica/db.ts`,
  `clientSchema.ts`, `meta.ts`, `daily.ts`, `sha256.ts`.
- `backend.md` § The write path "Key mechanics": the Conflicts, Missing
  targets and Concurrent-structure bullets are subsections wearing bullets.
- The `resyncSeq` exceptions in `sync-and-offline.md` have no owning section
  in the recovery doc.
- "Seven conditions", "Three tables", "Two more": counts that go stale
  silently.
- `sync-recovery.md` restates `backend.md` § Idempotency.
- `backend.md` omits that a diverted subtree loses nesting and heading, and
  that a create+edit of one uid in a batch lands both texts.
- Beside the pkm-e21b sibling misorder: a replayed cross-page move keeps the
  root but not a descendant a window re-shipped at the old page, until the
  echo (same class).
- `set_collapsed` on a missing block journals a row, the one departure from
  the plain no-op ruling: record it on pkm-foap so its ruling table and
  `backend.md` agree (both reviews: the right call).
- AGENTS.md: one line extending the no-bean-ids rule to code comments
  (decision 2026-09-29).

## Todo

- [x] The corrections above, verified against the code
- [x] pkm-foap record; AGENTS.md line
- [x] Shape pass under `architecture-docs`; `check-arch-docs` clean
- [ ] merge

## Summary of Changes

Docs-only, verified against the code on main.

Corrected (claims that were wrong or incomplete):
- D6: backend.md § Breadcrumbs and recursive traversal now tables all three
  mirrored walk pairs (`_fetch_ancestors`/`localApi/tree.ts`,
  `_parent_chain`/`localOps.parentChain`,
  `_subtree_deepest_first`/`localOps.subtreeUids`); sync-and-offline.md links
  to it instead of claiming "all three change together" of one lineage.
- D7: the stale-delete gap is stated as open in sync-and-offline.md's
  conflict table and backend.md § Conflicts, until the hash-guarded delete
  (pkm-nny8) ships.
- `missing_targets.json`'s scope: after merging pkm-rrzq, sync-recovery.md
  says its `cases` pin skip-or-not and its `placement_cases` pin where a
  create or move lands (one sentence, reconciled with rrzq's).
- The reconnect diagram no longer shows an unconditional resync bump; the
  stale "a tab with no replica bumps on skipped ops" line is gone (skipped
  ops bump whatever the replica state).
- backend.md § Missing targets: a diverted subtree lands flat and loses
  nesting, heading and view type; a create+edit of one uid lands both texts;
  the `set_collapsed` no-op row says why it journals.

Added:
- sync-recovery.md: the post-latch ordering inversion (failure-table row and
  a paragraph in A local write fails); the accepted windowed-replay
  misorders (pkm-e21b's sibling case and the cross-page move descendant case).
- sync-and-offline.md § When views refetch: one table of every `resyncSeq`
  trigger, replacing the Ancillary bullet; troubleshooting links repointed.
- frontend.md module map: sync/rejection.ts, sync/unloadGuard.ts,
  replica/db.ts, clientSchema.ts, meta.ts, refs.ts, daily.ts, sha256.ts.
- AGENTS.md: no bean ids in code or test comments.
- pkm-foap: ruling record for `set_collapsed` journalling.

Restructured (no claim changed):
- backend.md § The write path: Conflicts, Missing targets, Concurrent
  structure edits and Page mutations are subsections; Key mechanics keeps
  the short bullets.
- sync-recovery.md defers the idempotency hash and the journal ordering to
  backend.md; stale-prone counts ("Seven conditions", "Three tables", "Two
  more", "these four", "seven routes", "two invariants") reworded.
