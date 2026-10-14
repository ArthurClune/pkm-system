---
# pkm-wlkh
title: Deleting a page turns inbound links into plain text
status: completed
type: feature
priority: normal
created_at: 2026-10-13T19:43:18Z
updated_at: 2026-10-14T07:20:55Z
---

Design in progress (brainstorming 2026-10-13). Spec: docs/superpowers/specs/2026-10-13-page-delete-unlinks-design.md. Follows pkm-70ty: today a delete leaves [[A]] text whose next edit recreates the page.


## Checklist
- [x] Spec and plan (docs/superpowers/specs/2026-10-13-page-delete-unlinks-design.md, docs/superpowers/plans/2026-10-13-page-delete-unlinks.md)
- [x] Pure rewriter and planner (server/src/pkm/unlink.py)
- [x] block_rewrites replays unlink and inline steps
- [x] Store delete shell; DELETE route with lock, 409 blockers; GET /api/delete-preview
- [x] Journal cleanup keeps linked daily notes
- [x] Web delete dialog with counts and blocked list
- [x] Property checks for the rewriter
- [x] Architecture docs
- [x] Final review fixes
- [x] Merge
- [x] Deploy
- [x] Data repair of the 13 pkm-70ty blocks (needs Arthur's OK)

Follow-ups: pkm-xsgt (refuse deleting attribute pages), pkm-wvac (sync suite draws page deletes).


## Summary of Changes
- Deleting a page now rewrites every inbound `[[page]]`, `#page`, `#[[page]]` and `[label]([[page]])` on other pages to plain text, and replaces `((refs))`/embeds into the page's blocks with a plain copy of their text (task marker and leading `Name::` dropped, newlines folded, one level of nested refs inlined). Pure core in `server/src/pkm/unlink.py`; store shell `delete_page_unlinking`; the DELETE route takes the write lock like rename.
- The delete is refused (409 with the list) when a query names the page, when unlinking would change a block's leading attribute, or when a reference would survive (`residual`). `GET /api/delete-preview?title=` feeds the web dialog, which shows counts or a "Can't delete" list.
- `block_rewrites` gained `kind` (retitle | unlink | inline, with a SQLite CHECK — Arthur accepted the rename/hub VM-step cost, baseline re-recorded); stale offline edits get unlink/inline replayed with the delete's own title canonicalisation; unknown kinds are skipped.
- Journal cleanup keeps any daily note with an incoming link of any kind (refs/block_refs tables, not a text scan).
- Hypothesis properties for the rewriter (`server/tests/props/test_unlink_props.py`); architecture docs updated.
- Deployed 0d2c490a. Data repair: 9 blocks linking deleted pages (`#1`/`#3`/`#4`/`#5`/`#18`, `[[Keyboard shortcuts]]`) unlinked with the new rewriter; 4 blocks linking deleted daily notes re-derived, which recreated those notes. pkm-70ty sweep: 0 stale.
- Follow-ups: pkm-xsgt (refuse deleting attribute pages), pkm-wvac (sync property suite draws page deletes), pkm-6jge (perf harness timing flake).
