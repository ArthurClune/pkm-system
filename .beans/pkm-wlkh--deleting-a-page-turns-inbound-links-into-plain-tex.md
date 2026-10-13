---
# pkm-wlkh
title: Deleting a page turns inbound links into plain text
status: in-progress
type: feature
priority: normal
created_at: 2026-10-13T19:43:18Z
updated_at: 2026-10-13T21:55:54Z
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
- [ ] Deploy
- [ ] Data repair of the 13 pkm-70ty blocks (needs Arthur's OK)

Follow-ups: pkm-xsgt (refuse deleting attribute pages), pkm-wvac (sync suite draws page deletes).
