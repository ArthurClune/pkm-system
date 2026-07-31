---
# pkm-8kw2
title: 'Client/server parity: remaining depth-100 caps and blank-ref handling'
status: todo
type: task
priority: normal
created_at: 2026-07-31T16:50:33Z
updated_at: 2026-07-31T16:50:33Z
parent: pkm-ulae
---

Follow-up from pkm-ulae ops-branch final review (pkm-2fw1/pkm-1rb5).

Server-side traversal is now complete and cycle-safe (pkm-2fw1) and blank titles are handled at the store boundary (pkm-1rb5), but three parity holes remain:

- routes_pages.py:82 read-path ancestors CTE still caps at depth<100 (display-only breadcrumbs; guarded by test_hardening.py cycle test)
- web/src/replica/localOps.ts:69-76 subtreeUids still has s.depth < 100 and relies on that cap as its only cycle stop, so offline deep moves/deletes diverge from server semantics despite the file's "mirrors ops_apply" claim
- TS extractRefs blank-ref parity: server-side ref indexing now skips blank [[   ]] refs; the web replica's reindex would still locally mint a "   " page — grammar/fixture alignment is cross-stack work

- [ ] Align localOps.ts subtree traversal with the server's cycle-safe complete traversal
- [ ] Decide read-path ancestors cap (raise/remove/document)
- [ ] Align TS extractRefs blank-ref handling with server extract() + BlankTitleError skip
