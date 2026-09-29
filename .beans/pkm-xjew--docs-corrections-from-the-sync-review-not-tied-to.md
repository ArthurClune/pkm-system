---
# pkm-xjew
title: 'Docs corrections from the sync review not tied to a fix: D6, D7, carried-over items, AGENTS.md comment rule, shape pass'
status: todo
type: task
priority: normal
created_at: 2026-09-29T13:20:47Z
updated_at: 2026-09-29T13:56:30Z
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

- [ ] The corrections above, verified against the code
- [ ] pkm-foap record; AGENTS.md line
- [ ] Shape pass under `architecture-docs`; `check-arch-docs` clean
- [ ] merge
