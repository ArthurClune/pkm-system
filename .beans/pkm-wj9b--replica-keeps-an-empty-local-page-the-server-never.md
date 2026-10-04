---
# pkm-wj9b
title: Replica keeps an empty local page the server never made or renamed
status: in-progress
type: bug
priority: normal
created_at: 2026-10-04T16:59:29Z
updated_at: 2026-10-04T17:15:02Z
parent: pkm-nws9
---

Found by the widened sync property (pkm-dbr1 branch). (A) A creates on Fourth (local negative-id page), Fourth is renamed to Third before the pull; reconcilePage matches local pages to feed pages by title only, so the feed page lands as a new Third and the empty local Fourth stays. (B) A top-level move to a new title, skipped by the server (block deleted elsewhere): the server creates no page, the replica's local page is never removed. Oracle: 'page X: only in replica A'. Fixed scenarios: 'local page for a create whose page is renamed before the pull', 'local page for a skipped top-level move to a new title'. Fix on feat/pkm-dbr1-cross-page.

- [x] Design (in chat)
- [x] Unit tests pinning A and B
- [x] Fix
- [x] Fixed scenarios pass
- [ ] Docs: window order in sync-and-offline.md, troubleshooting row
