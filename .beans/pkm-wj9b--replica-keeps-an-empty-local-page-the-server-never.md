---
# pkm-wj9b
title: Replica keeps an empty local page the server never made or renamed
status: completed
type: bug
priority: normal
created_at: 2026-10-04T16:59:29Z
updated_at: 2026-10-04T19:16:26Z
parent: pkm-nws9
---

Found by the widened sync property (pkm-dbr1 branch). (A) A creates on Fourth (local negative-id page), Fourth is renamed to Third before the pull; reconcilePage matches local pages to feed pages by title only, so the feed page lands as a new Third and the empty local Fourth stays. (B) A top-level move to a new title, skipped by the server (block deleted elsewhere): the server creates no page, the replica's local page is never removed. Oracle: 'page X: only in replica A'. Fixed scenarios: 'local page for a create whose page is renamed before the pull', 'local page for a skipped top-level move to a new title'. Fix on feat/pkm-dbr1-cross-page.

- [x] Design (in chat)
- [x] Unit tests pinning A and B
- [x] Fix
- [x] Fixed scenarios pass
- [x] Docs: window order in sync-and-offline.md, troubleshooting row

## Summary of Changes

dropStrandedLocalPages (reconcile.ts) deletes a negative-id page with no blocks, no refs, no non-poisoned pending op naming it, not today's daily page and no effect-ledger base naming it. It runs last in applyWindow, at the head window only (a page whose create was acked mid-catch-up must not vanish for a window). Docs: sync-and-offline.md step 11; troubleshooting row.
